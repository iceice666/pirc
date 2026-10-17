/// The tiny PNG served by the document image cancellation fixture.
/// It is a 2x2 opaque solid RGB(37, 181, 92) image.
const String documentImageCancellationPngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGNQ3RrzH4QZYAwASxwI1Ze3ybAAAAAASUVORK5CYII=';

/// Shared by the Android integration test and the independent Chrome oracle.
const String documentImageCancellationFixture = r'''<!doctype html>
<html><body>
<button id="replace-start">開始單張替換</button>
<button id="replace-fast">改用新圖片</button>
<button id="six-start">開始六張慢圖片</button>
<button id="six-cancel">取消六張慢圖片</button>
<button id="seventh-load">載入第七張圖片</button>
<button id="consumer-start">開始兩個消費者</button>
<button id="consumer-replace">更新第一個消費者</button>
<button id="policy-start">開始策略圖片</button>
<button id="policy-update">更新referrerPolicy</button>
<button id="policy-next">載入策略更新後的新來源</button>
<button id="same-start">開始同來源圖片</button>
<button id="same-reset">重設相同src</button>
<canvas id="image-cancellation-canvas" width="8" height="8"
  style="display:block;width:8px;height:8px"></canvas>
<pre id="result">pending</pre>
<script>
const state = {
  replacement: {
    started: false, oldDecode: 'not-started', newDecode: 'not-started',
    newLoad: false, newError: 0, staleLoads: 0, currentSrc: '',
    naturalWidth: 0, naturalHeight: 0
  },
  six: {started: false, cancelled: false, oldDecodeRejected: 0, loaded: 0, errorCount: 0},
  seventh: {started: false, loaded: false, error: '', currentSrc: ''},
  consumer: {
    started: false, ownerOldDecode: 'not-started', ownerNewDecode: 'not-started',
    ownerLoaded: false, otherLoaded: false, otherError: '', otherCurrentSrc: ''
  },
  policy: {
    started: false, updated: false, nextStarted: false, currentSrc: '',
    nextCurrentSrc: '', nextError: ''
  },
  sameSrc: {
    started: false, reset: false, loaded: false, decode: 'not-started',
    currentSrc: '', naturalWidth: 0, naturalHeight: 0
  },
  canvas: {drawn: false, sourceIndex: null, imageId: '', width: 0, height: 0, rect: [2, 2, 4, 4]}
};
const output = document.getElementById('result');
function render() { output.textContent = JSON.stringify(state); }
function trackDecode(image, key, onSettle) {
  image.decode().then(
    () => onSettle('resolved'),
    error => onSettle('rejected:' + String(error && error.name || 'Error'))
  );
}
let replacementImage = null;
document.getElementById('replace-start').onclick = () => {
  if (replacementImage) return;
  const image = replacementImage = new Image();
  state.replacement.started = true;
  image.onload = () => {
    const current = image.currentSrc || image.src;
    if (current.includes('/image-ok.png?replace=1')) {
      state.replacement.newLoad = true;
      state.replacement.currentSrc = current;
      state.replacement.naturalWidth = image.naturalWidth;
      state.replacement.naturalHeight = image.naturalHeight;
    } else {
      state.replacement.staleLoads++;
    }
    render();
  };
  image.onerror = () => { state.replacement.newError++; render(); };
  image.src = '/slow-image-replace.png';
  state.replacement.oldDecode = 'pending';
  trackDecode(image, 'oldDecode', value => { state.replacement.oldDecode = value; render(); });
  render();
};
document.getElementById('replace-fast').onclick = () => {
  if (!replacementImage) return;
  replacementImage.src = '/image-ok.png?replace=1';
  state.replacement.newDecode = 'pending';
  trackDecode(replacementImage, 'newDecode', value => { state.replacement.newDecode = value; render(); });
  render();
};

let sixImages = [];
document.getElementById('six-start').onclick = () => {
  if (sixImages.length) return;
  state.six.started = true;
  sixImages = Array.from({length: 6}, (_, index) => {
    const image = new Image();
    image.onload = () => {
      state.six.loaded++;
      if (index === 0) {
        const canvas = document.getElementById('image-cancellation-canvas');
        const context = canvas.getContext('2d');
        context.fillStyle = '#112233';
        context.fillRect(0, 0, 8, 8);
        context.drawImage(image, 2, 2, 4, 4);
        state.canvas = {
          drawn: true, sourceIndex: 0, imageId: image.currentSrc || image.src,
          width: image.naturalWidth, height: image.naturalHeight, rect: [2, 2, 4, 4]
        };
      }
      render();
    };
    image.onerror = () => { state.six.errorCount++; render(); };
    image.src = '/slow-image-' + index + '.png';
    trackDecode(image, 'sixOldDecode', value => {
      if (value === 'rejected:EncodingError') state.six.oldDecodeRejected++;
      render();
    });
    return image;
  });
  render();
};
document.getElementById('six-cancel').onclick = () => {
  if (sixImages.length !== 6 || state.six.cancelled) return;
  state.six.cancelled = true;
  sixImages.forEach((image, index) => {
    image.src = '/image-ok.png?six=' + index;
    trackDecode(image, 'sixNewDecode', () => render());
  });
  render();
};
let seventhImage = null;
document.getElementById('seventh-load').onclick = () => {
  if (seventhImage) return;
  const image = seventhImage = new Image();
  state.seventh.started = true;
  image.onload = () => {
    state.seventh.loaded = true;
    state.seventh.currentSrc = image.currentSrc || image.src;
    render();
  };
  image.onerror = () => { state.seventh.error = 'error'; render(); };
  image.src = '/image-ok.png?seventh=1';
  trackDecode(image, 'seventhDecode', value => {
    if (value !== 'resolved') state.seventh.error = value;
    render();
  });
  render();
};

let ownerImage = null, otherImage = null;
document.getElementById('consumer-start').onclick = () => {
  if (ownerImage || otherImage) return;
  state.consumer.started = true;
  ownerImage = new Image();
  otherImage = new Image();
  ownerImage.onload = () => { state.consumer.ownerLoaded = true; render(); };
  otherImage.onload = () => {
    state.consumer.otherLoaded = true;
    state.consumer.otherCurrentSrc = otherImage.currentSrc || otherImage.src;
    render();
  };
  otherImage.onerror = () => { state.consumer.otherError = 'error'; render(); };
  ownerImage.src = '/slow-image-owner.png';
  otherImage.src = '/slow-image-other.png';
  state.consumer.ownerOldDecode = 'pending';
  trackDecode(ownerImage, 'ownerOldDecode', value => { state.consumer.ownerOldDecode = value; render(); });
  render();
};
document.getElementById('consumer-replace').onclick = () => {
  if (!ownerImage) return;
  ownerImage.src = '/image-ok.png?consumer=1';
  state.consumer.ownerNewDecode = 'pending';
  trackDecode(ownerImage, 'ownerNewDecode', value => { state.consumer.ownerNewDecode = value; render(); });
  render();
};

let policyImage = null;
document.getElementById('policy-start').onclick = () => {
  if (policyImage) return;
  policyImage = new Image();
  state.policy.started = true;
  policyImage.onload = () => { state.policy.currentSrc = policyImage.currentSrc || policyImage.src; render(); };
  policyImage.src = '/slow-image-policy.png';
  render();
};
document.getElementById('policy-update').onclick = () => {
  if (!policyImage) return;
  policyImage.referrerPolicy = 'no-referrer';
  state.policy.updated = true;
  render();
};
document.getElementById('policy-next').onclick = () => {
  if (!policyImage || state.policy.nextStarted) return;
  state.policy.nextStarted = true;
  policyImage.onload = () => { state.policy.nextCurrentSrc = policyImage.currentSrc || policyImage.src; render(); };
  policyImage.onerror = () => { state.policy.nextError = 'error'; render(); };
  policyImage.src = '/slow-image-policy-next.png';
  render();
};

let sameImage = null;
document.getElementById('same-start').onclick = () => {
  if (sameImage) return;
  sameImage = new Image();
  state.sameSrc.started = true;
  sameImage.onload = () => {
    state.sameSrc.loaded = true;
    state.sameSrc.currentSrc = sameImage.currentSrc || sameImage.src;
    state.sameSrc.naturalWidth = sameImage.naturalWidth;
    state.sameSrc.naturalHeight = sameImage.naturalHeight;
    render();
  };
  sameImage.src = '/slow-image-same.png';
  state.sameSrc.decode = 'pending';
  trackDecode(sameImage, 'sameDecode', value => { state.sameSrc.decode = value; render(); });
  render();
};
document.getElementById('same-reset').onclick = () => {
  if (!sameImage || state.sameSrc.reset) return;
  sameImage.src = sameImage.src;
  state.sameSrc.reset = true;
  render();
};
render();
</script>
</body></html>''';
