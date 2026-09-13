// Firebase SDK modüllerini import ediyoruz
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

// TODO: AŞAĞIDAKİ OBJEYİ KENDİ FİREBASE PROJENİZİN "firebaseConfig" OBJESİ İLE DEĞİŞTİRİN
const firebaseConfig = {
  apiKey: "AIzaSyD1FLYydwyTkmqOHm3SCH74UEHiAK5KE3s",
  authDomain: "book-reader-upload.firebaseapp.com",
  projectId: "book-reader-upload",
  storageBucket: "book-reader-upload.firebasestorage.app",
  messagingSenderId: "136369190426",
  appId: "1:136369190426:web:24901de4547ade9f2d83a3",
  measurementId: "G-131K3T7D1R"
};

// Firebase'i Başlat (Eğer konfigürasyon boşsa hata fırlatmaması için küçük bir kontrol)
let app, auth, db, storage;

try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    storage = getStorage(app);
    console.log("Firebase başarıyla başlatıldı!");
} catch (error) {
    console.error("Firebase başlatılırken hata oluştu:", error);
}

// Diğer dosyalarda kullanabilmek için dışarı aktar (export)
export { app, auth, db, storage };
