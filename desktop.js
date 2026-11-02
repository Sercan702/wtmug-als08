/* ==========================================================
   desktop.js — Web arayüzü: offer üret → QR göster →
   telefon cevap QR gösterirse onu oku → bağlantı tamamla
   ========================================================== */
(function () {
  'use strict';

  const { P2P } = window;
  const els = {};

  // QR okuma için jsQR
  const jsQRScript = document.createElement('script');
  jsQRScript.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
  document.head.appendChild(jsQRScript);

  document.addEventListener('DOMContentLoaded', async () => {
    P2P.setRole('desktop');
    els.qrBox       = document.getElementById('qr-box');
    els.matchScreen = document.getElementById('match-screen');
    els.answerScreen= document.getElementById('answer-screen');
    els.answerVideo = document.getElementById('answer-video');

    // 1) Offer üret
    let offerB64;
    try {
      offerB64 = await P2P.createOffer();
    } catch (e) {
      P2P.toast('Offer üretilemedi: ' + e.message);
      return;
    }

    // 2) QR koda bas
    renderQR(offerB64);

    // 3) Telefon QR okuduktan sonra cevap QR gösterecek → web tarafı kameradan okumalı.
    // Kullanıcıya "Cevap QR'ı Okut" butonu yerine otomatik kamera açabiliriz;
    // ancak ilk offer QR'ının ekranda kalması gerek. Bu yüzden 3 sn sonra
    // answer ekranına geçip kamerayı başlatıyoruz. (Kullanıcı isterse geri döner.)

    // Answer QR'ı okumak için kamerayı başlat
    setTimeout(() => startAnswerScanner(), 1500);
  });

  function renderQR(text) {
    // qrcode kütüphanesi canvas üretir
    const canvas = document.createElement('canvas');
    window.QRCode.toCanvas(canvas, text, {
      width: 260,
      margin: 2,
      errorCorrectionLevel: 'L', // daha fazla kapasite
      color: { dark: '#000000', light: '#ffffff' }
    }, (err) => {
      if (err) {
        els.qrBox.textContent = 'QR üretilemedi: ' + err.message;
        return;
      }
      els.qrBox.innerHTML = '';
      els.qrBox.appendChild(canvas);
    });
  }

  async function startAnswerScanner() {
    // Cevap ekranını göster (offer QR'ı küçülmüş olacak — kullanıcı iki QR'ı da görebilir)
    els.answerScreen.classList.remove('hidden');
    els.matchScreen.style.minHeight = '0';
    els.matchScreen.style.flex = '0';

    try {
      await P2P.startCamera(els.answerVideo);
    } catch (e) {
      return; // kamera yoksa sadece QR göster
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const scan = () => {
      if (els.answerVideo.readyState === els.answerVideo.HAVE_ENOUGH_DATA) {
        canvas.width  = els.answerVideo.videoWidth;
        canvas.height = els.answerVideo.videoHeight;
        ctx.drawImage(els.answerVideo, 0, 0);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (window.jsQR) {
          const code = window.jsQR(imgData.data, canvas.width, canvas.height, {
            inversionAttempts: 'dontInvert'
          });
          if (code && code.data) {
            handleAnswerScanned(code.data);
            return;
          }
        }
      }
      requestAnimationFrame(scan);
    };
    requestAnimationFrame(scan);
  }

  async function handleAnswerScanned(b64Answer) {
    P2P.stopCamera();
    try {
      await P2P.applyAnswer(b64Answer);
      P2P.toast('Bağlantı kuruluyor…');
      // pc.ondatachannel → bindDataChannel → dc.onopen → setConnected(true)
    } catch (e) {
      P2P.toast('Cevap uygulanamadı: ' + e.message);
    }
  }
})();