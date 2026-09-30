'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const katex = require('katex');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const MODEL_ID = 'onnx-community/nougat-latex-base-ONNX';
const MODEL_REVISION = '114e14f31dc155a098ba4cfd32124e031251f759';
const MAX_TOKENS = 800;
const BEAMS = 5;

function createMathOcr() {
    const cacheRoot = path.join(os.homedir(), '.cache', 'reader-math-ocr');
    const modelDirectory = path.join(cacheRoot, MODEL_ID);
    let modelPromise;
    let queue = Promise.resolve();
    let stopped = false;

    async function modelFile(name) {
        const file = path.join(modelDirectory, name);
        try {
            const stat = await fs.promises.stat(file);
            if (stat.isFile() && stat.size > 0) return file;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        const temporary = file + '.' + process.pid + '.tmp';
        try {
            console.log('Matematik OCR modeli indiriliyor:', name);
            const response = await fetch('https://huggingface.co/' + MODEL_ID + '/resolve/' + MODEL_REVISION + '/' + name);
            if (!response.ok || !response.body) throw new Error('Model indirme hatası: HTTP ' + response.status);
            await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
            await fs.promises.rename(temporary, file);
        } finally {
            await fs.promises.rm(temporary, { force: true });
        }
        return file;
    }

    async function load() {
        if (!modelPromise) {
            modelPromise = (async () => {
                const transformers = await import('@huggingface/transformers');
                const ort = require('onnxruntime-node');
                await Promise.all([
                    'config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json',
                    'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_quantized.onnx'
                ].map(modelFile));
                // No network access is needed after assets have been installed.
                const options = { local_files_only: true };
                const [processor, tokenizer] = await Promise.all([
                    transformers.AutoProcessor.from_pretrained(modelDirectory, options),
                    transformers.AutoTokenizer.from_pretrained(modelDirectory, options)
                ]);
                const encoderFile = path.join(modelDirectory, 'onnx/encoder_model_quantized.onnx');
                const decoderFile = path.join(modelDirectory, 'onnx/decoder_model_quantized.onnx');
                const sessionOptions = { executionProviders: ['cpu'], intraOpNumThreads: 2 };
                const encoder = await ort.InferenceSession.create(encoderFile, sessionOptions);
                let decoder;
                try {
                    decoder = await ort.InferenceSession.create(decoderFile, sessionOptions);
                } catch (error) {
                    await encoder.release();
                    throw error;
                }
                return { transformers, ort, processor, tokenizer, encoder, decoder };
            })();
            modelPromise.catch(() => { modelPromise = undefined; });
        }
        return modelPromise;
    }

    async function recognize({ imageBuffer }) {
        const { transformers, ort, processor, tokenizer, encoder, decoder } = await load();
        const source = await loadImage(imageBuffer);
        // Tight single-symbol crops otherwise fill the encoder height, unlike
        // the equation-scale glyphs used by the model. Add white context, not ink.
        if (source.height < 96) {
            const canvas = createCanvas(Math.max(source.width, 192), 96);
            const context = canvas.getContext('2d');
            context.fillStyle = '#fff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(source, (canvas.width - source.width) / 2, (canvas.height - source.height) / 2);
            imageBuffer = canvas.toBuffer('image/png');
            canvas.width = 0; canvas.height = 0;
        }
        const image = await transformers.RawImage.fromBlob(new Blob([imageBuffer], { type: 'image/png' }));
        const pixels = (await processor(image)).pixel_values;
        const input = new ort.Tensor('float32', pixels.data, pixels.dims);
        let hidden;
        let expandedHidden;
        try {
            hidden = (await encoder.run({ pixel_values: input })).last_hidden_state;
            let beams = [{ ids: [0], score: 0 }];
            const completed = [];
            for (let length = 1; length <= MAX_TOKENS; length++) {
                const ids = new BigInt64Array(beams.length * length);
                beams.forEach((beam, batch) => beam.ids.forEach((id, i) => { ids[batch * length + i] = BigInt(id); }));
                if (beams.length > 1 && !expandedHidden) {
                    const data = new Float32Array(hidden.data.length * BEAMS);
                    for (let batch = 0; batch < BEAMS; batch++) data.set(hidden.data, batch * hidden.data.length);
                    expandedHidden = new ort.Tensor('float32', data, [BEAMS, ...hidden.dims.slice(1)]);
                }
                const tokenInput = new ort.Tensor('int64', ids, [beams.length, length]);
                let logits;
                const candidates = [];
                try {
                    logits = (await decoder.run({ input_ids: tokenInput,
                        encoder_hidden_states: beams.length === 1 ? hidden : expandedHidden })).logits;
                    const vocabulary = logits.dims[logits.dims.length - 1];
                    for (let batch = 0; batch < beams.length; batch++) {
                        const offset = (batch * length + length - 1) * vocabulary;
                        let maximum = -Infinity, sum = 0;
                        for (let token = 0; token < vocabulary; token++) maximum = Math.max(maximum, logits.data[offset + token]);
                        for (let token = 0; token < vocabulary; token++) sum += Math.exp(logits.data[offset + token] - maximum);
                        const normalizer = maximum + Math.log(sum);
                        for (let token = 2; token < vocabulary; token++) {
                            const score = beams[batch].score + logits.data[offset + token] - normalizer;
                            if (candidates.length === BEAMS * 2 && score <= candidates[candidates.length - 1].score) continue;
                            let at = 0;
                            while (at < candidates.length && candidates[at].score >= score) at++;
                            candidates.splice(at, 0, { batch, token, score });
                            if (candidates.length > BEAMS * 2) candidates.pop();
                        }
                    }
                } finally {
                    if (logits) logits.dispose();
                    tokenInput.dispose();
                }
                const next = [];
                candidates.forEach((candidate, rank) => {
                    if (candidate.token === 2) {
                        if (rank < BEAMS) completed.push({ ids: beams[candidate.batch].ids, score: candidate.score / length });
                    } else if (next.length < BEAMS) {
                        next.push({ ids: [...beams[candidate.batch].ids, candidate.token], score: candidate.score });
                    }
                });
                if (completed.length >= BEAMS || !next.length) break;
                beams = next;
            }
            if (!completed.length) throw new Error('Denklem tanıma tamamlanamadı; model token sınırına ulaştı.');
            completed.sort((a, b) => b.score - a.score);
            let syntaxError;
            for (const candidate of completed) {
                let latex = tokenizer.decode(candidate.ids, { skip_special_tokens: true }).trim();
                if (latex.startsWith('$$') && latex.endsWith('$$')) latex = latex.slice(2, -2).trim();
                else if (latex.startsWith('$') && latex.endsWith('$')) latex = latex.slice(1, -1).trim();
                if (!latex) continue;
                // Rank actual model hypotheses; syntax validity alone does not establish accuracy.
                try {
                    katex.renderToString(latex, { throwOnError: true, trust: false });
                    return latex;
                } catch (error) { syntaxError = error; }
            }
            throw syntaxError || new Error('Matematik OCR geçerli bir denklem döndürmedi.');
        } finally {
            input.dispose();
            if (expandedHidden) expandedHidden.dispose();
            if (hidden) hidden.dispose();
        }
    }

    function recognizeMath(region) {
        if (stopped) return Promise.reject(new Error('Matematik OCR kapatılıyor.'));
        const result = queue.then(() => recognize(region));
        queue = result.catch(() => {});
        return result;
    }

    async function shutdown() {
        stopped = true;
        await queue;
        if (modelPromise) {
            const model = await modelPromise;
            await model.encoder.release();
            await model.decoder.release();
            modelPromise = undefined;
        }
    }

    return { recognizeMath, shutdown, prepare: load };
}

module.exports = createMathOcr;

if (require.main === module) {
    const service = createMathOcr();
    service.prepare().then(() => {
        console.log('Yerel matematik OCR hazır; model dosyaları diskte önbelleğe alındı.');
    }).finally(() => service.shutdown()).catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
