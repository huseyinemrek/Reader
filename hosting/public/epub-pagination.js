import { objectViewCss, wrapObject, unwrapObjects, installObjectView } from './epub-object-view.js';

const scope = '#reader-view.paged-mode #book-content';
export const paginationCss = objectViewCss + `
${scope} .epub-chapter [data-reader-image-block] { padding-block:0!important; margin-block:20px!important; break-inside:avoid; }
${scope} .epub-chapter [data-reader-image-block] [data-reader-image-block] { margin-block:0!important; }
${scope} .epub-chapter [data-reader-image-block] img { display:block; margin:0 auto!important; }
${scope} .epub-chapter img[data-reader-image-block] { display:block; margin:20px auto!important; }
${scope}[data-reader-layout-measuring] { column-width:auto!important; column-count:auto!important; height:auto!important; }
${scope} .epub-chapter [data-reader-layout-height] { max-height:var(--reader-layout-height)!important; }
${scope} .epub-chapter [data-reader-layout-part] { break-inside:avoid-column!important; break-after:avoid-column!important; }
${scope} .epub-chapter [data-reader-layout-part="end"] { break-after:auto!important; }
${scope} .epub-chapter [data-reader-layout-inside] { break-inside:avoid-column!important; }
${scope} .epub-chapter [data-reader-layout-before="avoid"] { break-before:avoid-column!important; }
${scope} .epub-chapter [data-reader-layout-after="avoid"] { break-after:avoid-column!important; }
${scope} .epub-chapter [data-reader-layout-after="auto"] { break-after:auto!important; }
${scope} .epub-chapter [data-reader-layout-before="column"] { break-before:column!important; }
${scope} .epub-chapter [data-reader-layout-after="column"] { break-after:column!important; }
${scope} .epub-chapter [data-reader-layout-break] { break-before:column!important; }
${scope} .epub-chapter h1, ${scope} .epub-chapter h2, ${scope} .epub-chapter h3,
${scope} .epub-chapter h4, ${scope} .epub-chapter h5, ${scope} .epub-chapter h6 { break-after:avoid-column; }
`;

const forced = value => /^(page|column|always|left|right|recto|verso)$/.test(value);
const avoid = value => /^avoid(?:-page|-column)?$/.test(value);
const imageOf = node => node.matches('img') ? node : node.querySelector('img');
const caption = node => node && (node.matches('figcaption,[role="doc-caption"]') ||
    /(?:^|[\s_-])(?:caption|figcaption|cap\w*\d|figcap\w*)(?:$|[\s_-])/i.test(node.className || ''));
const credit = node => node && /(?:^|[\s_-])(?:credit\w*|copyright)(?:$|[\s_-])/i.test(node.className || '');
const heading = node => /^H[1-6]$/.test(node.tagName);
const attrNames = ['part','height','inside','before','after','break'];

function sourceNodes(section) {
    return [...section.querySelectorAll('*')].filter(node => !node.matches('style,script') && !node.closest('[data-reader-ui]'));
}
function reset(section) {
    unwrapObjects(section);
    for (const node of sourceNodes(section)) {
        attrNames.forEach(name => node.removeAttribute('data-reader-layout-' + name));
        node.style.removeProperty('--reader-layout-height');
    }
}
function sameParent(parts) { return parts.every(node => node.parentElement === parts[0].parentElement); }
function collectGroups(section, nodes) {
    const groups = [];
    const claimed = new Set();
    for (const table of section.querySelectorAll('table')) {
        if (!table.parentElement.closest('table')) groups.push({parts:[table], kind:'table'});
    }
    for (const figure of section.querySelectorAll('figure')) {
        if (figure.parentElement.closest('figure') || figure.querySelectorAll('img').length !== 1 || figure.querySelector('table')) continue;
        const image = imageOf(figure);
        groups.push({parts:[figure], image, kind:'figure'});
        claimed.add(image);
    }
    const images = [...section.querySelectorAll('[data-reader-image-block]')]
        .filter(node => !node.parentElement.closest('[data-reader-image-block]') && !claimed.has(imageOf(node)) && !node.closest('table'));
    for (const node of images) {
        const image = imageOf(node);
        if (!image) continue;
        const parts = [node];
        const described = new Set((image.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
        let next = node.nextElementSibling;
        if (next && (caption(next) || described.has(next.id))) {
            parts.push(next);
            next = next.nextElementSibling;
            while (next && credit(next)) { parts.push(next); next = next.nextElementSibling; }
            groups.push({parts, image, kind:'figure'});
        }
    }
    const ids = new Map(nodes.map((node,index) => [node,index]));
    return groups.map(group => ({...group, ids:group.parts.map(node=>ids.get(node)), imageId:ids.get(group.image)}));
}

// Only unclassified, genuinely isolated body text is eligible for the older
// inter-image packing. Explicit figure ownership is never overridden by it.
function gapCandidates(section, groups, ids) {
    const owned = new Set(groups.flatMap(group => group.parts));
    const images = [...section.querySelectorAll('[data-reader-image-block]')]
        .filter(node => !node.parentElement.closest('[data-reader-image-block]'));
    const candidates = [];
    for (let i=1;i<images.length;i++) {
        let left=images[i-1], right=images[i], parent=left.parentElement;
        while (parent && !parent.contains(right)) parent=parent.parentElement;
        if (!parent || !section.contains(parent)) continue;
        while (left.parentElement!==parent) left=left.parentElement;
        while (right.parentElement!==parent) right=right.parentElement;
        if (left===right || left.textContent.trim() || right.textContent.trim()) continue;
        const parts=[];
        let valid=true;
        for(let node=left.nextSibling;node&&node!==right;node=node.nextSibling) {
            if(node.nodeType===3&&node.textContent.trim()) {valid=false;break;}
            if(node.nodeType!==1||!node.textContent.trim()) continue;
            if(node.matches('h1,h2,h3,h4,h5,h6,table,hr,figure') || node.querySelector('img,svg,table,hr,h1,h2,h3,h4,h5,h6') || caption(node) || credit(node) || owned.has(node)) {valid=false;break;}
            parts.push(node);
        }
        if(valid&&parts.length) candidates.push({left,right,parts, ids:parts.map(node=>ids.get(node)), owned});
    }
    return candidates;
}

// Pure bounded look-ahead: evaluate a fixed window, keep at most four states
// per page, and never enumerate alternate DOM renders. Atomic blocks are the
// only explicit break candidates; normal long paragraphs stay with the browser.
export function chooseBlockBreaks(blocks, height) {
    if (!(height>0) || blocks.length<2) return [];
    const breaks=[];
    let start=0;
    while(start<blocks.length) {
        let end=start, sum=0;
        while(end<blocks.length&&end-start<32&&(sum<height*3||end===start)) sum+=blocks[end++].height;
        const window=blocks.slice(start,end);
        if(window.some(block=>block.height>height||block.height<=0)) {start++;continue;}
        let states=[{pos:0,cost:0,first:null,pages:0}];
        const completed=[];
        for(let depth=0;depth<3&&states.length;depth++) {
            const next=[];
            for(const state of states) {
                let used=0;
                for(let j=state.pos;j<window.length;j++) {
                    if(j>state.pos&&window[j].forced) break;
                    used+=window[j].height;
                    if(used>height+.5) break;
                    if(window[j].keepAfter&&j+1<window.length&&!window[j+1].forced) continue;
                    const last=j+1===window.length;
                    const empty=(height-used)/height;
                    const candidate={pos:j+1,pages:state.pages+1,first:state.first??j+1,
                        cost:state.cost+100+(last ? 0 : empty*empty*10)};
                    if(last) completed.push(candidate); else next.push(candidate);
                }
            }
            // Progress dominates estimates near the bounded horizon.
            next.sort((a,b)=>(a.cost+Math.ceil(window.slice(a.pos).reduce((s,b)=>s+b.height,0)/height)*100)-
                (b.cost+Math.ceil(window.slice(b.pos).reduce((s,b)=>s+b.height,0)/height)*100)||b.pos-a.pos);
            states=next.slice(0,4);
        }
        const choices=completed.length?completed:states;
        choices.sort((a,b)=>a.cost-b.cost||b.pos-a.pos);
        const count=choices[0]?.first;
        if(!count) {start++;continue;}
        start+=count;
        if(start<blocks.length) breaks.push(blocks[start].id);
    }
    return breaks;
}

function chooseGaps(options) {
    const selected=[];
    const used=new Set();
    for(let i=0;i<options.length;i++) {
        let states=[{cost:0,used:new Set(used),first:null}];
        for(let j=i;j<Math.min(options.length,i+3);j++) {
            const next=[];
            for(const state of states) {
                next.push({...state,cost:state.cost+10});
                for(const option of options[j]) {
                    if(state.used.has(option.image)) continue;
                    const claimed=new Set(state.used); claimed.add(option.image);
                    next.push({used:claimed,cost:state.cost+option.shrink**2*8+(option.side==='before'?.01:0),
                        first:j===i?option:state.first});
                }
            }
            states=next.sort((a,b)=>a.cost-b.cost).slice(0,4);
        }
        const first=states[0]?.first;
        if(first) {selected.push(first.action);used.add(first.image);}
    }
    return selected;
}

function apply(section,nodes,plan,height) {
    for(const entry of plan) {
        if(entry.type==='rule') {
            const node=nodes[entry.node]; if(!node) continue;
            for(const name of ['before','after','inside']) if(entry[name]) node.setAttribute('data-reader-layout-'+name,entry[name]);
        } else if(entry.type==='break') nodes[entry.node]?.setAttribute('data-reader-layout-break','');
        else if(entry.type==='group') {
            const parts=entry.nodes.map(index=>nodes[index]);
            parts.forEach((node,index)=>node.setAttribute('data-reader-layout-part',index===parts.length-1?'end':'keep'));
            if(entry.image!==undefined&&entry.height) {
                const image=nodes[entry.image];
                image.setAttribute('data-reader-layout-height','');
                image.style.setProperty('--reader-layout-height',entry.height+'px');
            }
        } else if(entry.type==='object') {
            wrapObject(entry.nodes.map(index=>nodes[index]),{height:height-2,kind:entry.kind});
        }
    }
    installObjectView(section.closest('#book-content'));
}

function validPlan(plan) {
    const id=value=>Number.isSafeInteger(value)&&value>=0;
    return Array.isArray(plan)&&plan.every(entry=>entry&&(
        entry.type==='rule'&&id(entry.node)&&['before','after','inside'].every(key=>!entry[key]||['column','avoid','auto'].includes(entry[key])) ||
        entry.type==='break'&&id(entry.node) ||
        ['group','object'].includes(entry.type)&&Array.isArray(entry.nodes)&&entry.nodes.length>0&&entry.nodes.every(id)&&
        (entry.image===undefined||id(entry.image))&&(entry.height===undefined||Number.isFinite(entry.height)&&entry.height>0)&&
        (entry.type!=='object'||['table','figure'].includes(entry.kind))));
}

export function createEpubPagination() {
    const layouts=new Map(), applied=new WeakMap();
    const plansFor=key=>{
        if(!layouts.has(key)) {layouts.set(key,new Map());if(layouts.size>2)layouts.delete(layouts.keys().next().value);}
        return layouts.get(key);
    };
    return {
        restore(key,plans) {
            if(!Array.isArray(plans)||!plans.every(validPlan))return false;
            const cache=plansFor(key);plans.forEach((plan,index)=>cache.set(index,plan));return true;
        },
        serialize(key,length) {const cache=plansFor(key);return Array.from({length},(_,index)=>cache.get(index)||[]);},
        fit(article,key) {
            const root=article.closest('#book-content');
            if(!root?.closest('#reader-view.paged-mode')) return;
            const sections=article.matches('.epub-chapter')?[article]:[...article.querySelectorAll('.epub-chapter')];
            const view=root.ownerDocument.defaultView, rootStyle=view.getComputedStyle(root);
            const H=parseFloat(rootStyle.height), width=parseFloat(rootStyle.columnWidth), stride=width+parseFloat(rootStyle.columnGap);
            if(!(H>0&&width>0&&stride>0))return;
            const cache=plansFor(key);
            for(const section of sections) {
                if(applied.get(section)===key)continue;
                reset(section);
                const nodes=sourceNodes(section), ids=new Map(nodes.map((node,index)=>[node,index]));
                const index=Number(section.dataset.index);
                if(cache.has(index)) {
                    const plan=cache.get(index);
                    const maxId=Math.max(-1,...plan.flatMap(entry=>entry.nodes||[entry.node]));
                    if(maxId<nodes.length) {apply(section,nodes,plan,H);applied.set(section,key);continue;}
                    cache.delete(index);
                }
                const sectionStyle=view.getComputedStyle(section);
                if(section.dataset.readerLayoutType==='pre-paginated'||sectionStyle.writingMode!=='horizontal-tb'||sectionStyle.direction==='rtl') {
                    cache.set(index,[]);applied.set(section,key);continue;
                }
                const styles=nodes.map(node=>{
                    const css=view.getComputedStyle(node);
                    return {before:css.breakBefore,after:css.breakAfter,inside:css.breakInside,display:css.display,
                        float:css.cssFloat,position:css.position,top:Math.max(0,parseFloat(css.marginTop)||0),
                        bottom:Math.max(0,parseFloat(css.marginBottom)||0)};
                });
                const rulePlan=[];
                styles.forEach((css,node)=>{
                    if(css.display==='inline'||css.display==='none')return;
                    const entry={type:'rule',node};
                    if(forced(css.before))entry.before='column';else if(avoid(css.before))entry.before='avoid';
                    if(forced(css.after))entry.after='column';else if(avoid(css.after))entry.after='avoid';
                    if(avoid(css.inside))entry.inside='avoid';
                    if(Object.keys(entry).length>2)rulePlan.push(entry);
                });
                const groups=collectGroups(section,nodes);
                const hasInternalBreak=group=>group.parts.some((part,i)=>{
                    const own=styles[ids.get(part)];
                    return i>0&&forced(own.before)||i<group.parts.length-1&&forced(own.after)||
                        [...part.querySelectorAll('*')].some(child=>{const css=styles[ids.get(child)];return css&&(forced(css.before)||forced(css.after));});
                });
                const safeGroups=groups.filter(group=>!hasInternalBreak(group));
                // A caption's keep-with-next cannot claim the next independent image.
                for(const group of safeGroups.filter(group=>group.kind==='figure')) {
                    const last=group.parts.at(-1), lastId=ids.get(last);
                    if(!forced(styles[lastId].after))rulePlan.push({type:'rule',node:lastId,after:'auto'});
                }
                apply(section,nodes,rulePlan,H);
                const origin=root.getBoundingClientRect().left+parseFloat(rootStyle.paddingLeft);
                const column=rect=>Math.floor((rect.left-origin+.5)/stride);
                const range=root.ownerDocument.createRange();
                const gaps=gapCandidates(section,groups,ids).filter(candidate=>{
                    const imageColumns=[candidate.left,candidate.right].map(node=>column(imageOf(node).getBoundingClientRect()));
                    const columns=new Set();
                    return candidate.parts.every(part=>{
                        range.selectNodeContents(part);
                        return [...range.getClientRects()].filter(rect=>rect.width>0&&rect.height>0).every(rect=>{
                            const value=column(rect);columns.add(value);return !imageColumns.includes(value)&&columns.size<=1;
                        });
                    })&&columns.size===1;
                });
                const plan=[...rulePlan];
                root.dataset.readerLayoutMeasuring='';
                let rects, gapOptions;
                try {
                    rects=nodes.map(node=>node.getBoundingClientRect());
                    const box=parts=>{
                        const first=ids.get(parts[0]),last=ids.get(parts.at(-1));
                        return rects[last].bottom-rects[first].top+styles[first].top+styles[last].bottom;
                    };
                    for(const group of safeGroups) {
                        const total=box(group.parts);
                        const overflow=group.parts.some(part=>part.scrollWidth>width+2);
                        if(group.kind==='table') {
                            plan.push({type:total>H-2||overflow?'object':'group',nodes:group.ids,kind:'table'});
                        } else {
                            const imageHeight=rects[group.imageId].height;
                            const target=Math.floor(Math.min(imageHeight,imageHeight+H-total-2));
                            const diagram=/diagram|chart|graph|equation|formula|\btable\b|şema|tablo/i.test(group.image.getAttribute('alt')||'');
                            if(total<=H-2||target>0&&target>=imageHeight*(diagram?1:.75)) {
                                plan.push({type:'group',nodes:group.ids,image:group.imageId,height:Math.max(1,target),kind:'figure'});
                            } else if(sameParent(group.parts))plan.push({type:'object',nodes:group.ids,kind:'figure'});
                        }
                    }
                    gapOptions=gaps.map(candidate=>{
                        const textHeight=rects[candidate.ids.at(-1)].bottom-rects[candidate.ids[0]].top;
                        if(textHeight<=0||textHeight>H*.25||candidate.ids.some(id=>forced(styles[id].before)||forced(styles[id].after)))return [];
                        return ['after','before'].flatMap(side=>{
                            const block=side==='after'?candidate.left:candidate.right;
                            if(candidate.owned.has(block)||groupContains(groups,block))return [];
                            const blockId=ids.get(block),image=imageOf(block),imageId=ids.get(image);
                            if(forced(styles[blockId].before)||forced(styles[blockId].after))return [];
                            const imageHeight=rects[imageId].height;
                            if(imageHeight<H*.6)return [];
                            const parts=side==='after'?[block,...candidate.parts]:[...candidate.parts,block];
                            const target=Math.floor(Math.min(imageHeight,H-box(parts)+imageHeight-2));
                            const shrink=1-target/imageHeight;
                            return target>0&&shrink>=0&&shrink<=.25?[{side,shrink,image:imageId,
                                action:{type:'group',nodes:parts.map(node=>ids.get(node)),image:imageId,height:target,kind:'flow'}}]:[];
                        });
                    });
                } finally {delete root.dataset.readerLayoutMeasuring;}
                plan.push(...chooseGaps(gapOptions));
                apply(section,nodes,plan.filter(entry=>entry.type!=='rule'),H);
                // Plan only simple sibling flows. Complex wrappers, floats and
                // long prose retain native line fragmentation; no DOM splitting.
                const groupStarts=new Map(plan.filter(entry=>['group','object'].includes(entry.type)).map(entry=>[entry.nodes[0],entry]));
                const grouped=new Set([...groupStarts.values()].flatMap(entry=>entry.nodes.slice(1)));
                const extraBreaks=new Set();
                for(const parent of [section,...section.querySelectorAll('section,article,div')]) {
                    if(parent.closest('.reader-object-shell')||parent.matches('.reader-object-shell'))continue;
                    const children=[...parent.children].filter(node=>ids.has(node));
                    if(children.length<2)continue;
                    const units=[];
                    let eligible=true,previousBottom=0;
                    for(const child of children) {
                        const id=ids.get(child);
                        if(grouped.has(id))continue;
                        const css=styles[id],group=groupStarts.get(id);
                        if(css.float!=='none'||!['static','relative'].includes(css.position)||
                            !group&&!child.matches('p,h1,h2,h3,h4,h5,h6,table,img,hr')) {eligible=false;break;}
                        const last=group?.nodes.at(-1)??id;
                        if(group&&!group.nodes.every(n=>nodes[n].parentElement===parent)) {eligible=false;break;}
                        let height=rects[last].bottom-rects[id].top;
                        if(group?.type==='object')height=H-2;
                        else if(group?.image!==undefined)height-=Math.max(0,rects[group.image].height-group.height);
                        const margin=Math.max(previousBottom,css.top);
                        const forcedBefore=forced(css.before);
                        units.push({id,height:height+margin,keepAfter:heading(child)||avoid(styles[last].after),forced:forcedBefore});
                        previousBottom=styles[last].bottom;
                    }
                    if(eligible&&units.every(unit=>unit.height<=H)) {
                        for(const id of chooseBlockBreaks(units,H))extraBreaks.add(id);
                    }
                }
                if(extraBreaks.size) {
                    const beforeWidth=root.scrollWidth;
                    const score=()=>{
                        const bottom=new Map(),top=root.getBoundingClientRect().top+parseFloat(rootStyle.paddingTop);
                        for(const node of section.querySelectorAll('p,h1,h2,h3,h4,h5,h6,table,img,.reader-object-shell')) {
                            if(node.closest('[data-reader-ui]')||node.parentElement.closest('.reader-object-shell,table'))continue;
                            for(const rect of node.getClientRects()) if(rect.width>0&&rect.height>0) {
                                const page=column(rect),end=Math.min(H,Math.max(0,rect.bottom-top));
                                bottom.set(page,Math.max(bottom.get(page)||0,end));
                            }
                        }
                        const last=Math.max(-1,...bottom.keys());
                        return [...bottom].reduce((sum,[page,end])=>sum+(page===last?0:(1-end/H)**2),0);
                    };
                    const beforeScore=score();
                    for(const id of extraBreaks)nodes[id].setAttribute('data-reader-layout-break','');
                    if(root.scrollWidth<=beforeWidth+1&&score()<beforeScore-.001) {
                        for(const id of extraBreaks)plan.push({type:'break',node:id});
                    } else for(const id of extraBreaks)nodes[id].removeAttribute('data-reader-layout-break');
                }
                // Validate protected groups against real column fragments. A
                // misplaced group gets its own start; if still split, keep it
                // in an accessible object surface rather than clipping content.
                for(const entry of [...plan]) {
                    if(entry.type!=='group')continue;
                    const parts=entry.nodes.map(id=>nodes[id]);
                    const columns=new Set();
                    for(const part of parts) {
                        range.selectNodeContents(part);
                        for(const rect of range.getClientRects()) if(rect.width>0&&rect.height>0)columns.add(column(rect));
                    }
                    if(columns.size<=1)continue;
                    parts[0].setAttribute('data-reader-layout-break','');
                    plan.push({type:'break',node:entry.nodes[0]});
                    const fragments=parts.flatMap(part=>[...part.getClientRects()]);
                    if(new Set(fragments.filter(rect=>rect.width>0).map(column)).size>1&&entry.kind!=='flow'&&sameParent(parts)) {
                        entry.type='object';delete entry.image;delete entry.height;
                        wrapObject(parts,{height:H-2,kind:entry.kind});
                    }
                }
                cache.set(index,plan);applied.set(section,key);
            }
        }
    };
}

function groupContains(groups,node) {return groups.some(group=>group.parts.some(part=>part.contains(node)||node.contains(part)));}
