// ===== 手掌参照物数据库 =====
const handDatabase = {
  adult: { male: { middle: 83, palm: 107, width: 105 }, female: { middle: 77, palm: 97, width: 92 } },
  elderly: { male: { middle: 80, palm: 104, width: 102 }, female: { middle: 75, palm: 95, width: 90 } },
  teen: { male: { middle: 79, palm: 102, width: 100 }, female: { middle: 73, palm: 92, width: 87 } },
  child: { male: { middle: 58, palm: 136, width: 80 }, female: { middle: 56, palm: 133, width: 78 } }
};

const handSizeMultiplier = { small: 0.88, average: 1.0, large: 1.12 };

// ===== State =====
let cocoModel = null;
let handsModel = null;
let img = null;
let imgWidth = 0, imgHeight = 0;
let displayScale = 1;
let detectedObjects = [];
let detectedHands = [];
let scalePxPerMm = null;
let selectedObject = null;
let manualPoints = [];

// ===== DOM Elements =====
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');
const uploadSection = document.getElementById('uploadSection');
const uploadCard = document.getElementById('uploadCard');
const fileInput = document.getElementById('fileInput');
const analysisSection = document.getElementById('analysisSection');
const resultSection = document.getElementById('resultSection');
const resultCanvas = document.getElementById('resultCanvas');
const resultCtx = resultCanvas.getContext('2d');
const manualSection = document.getElementById('manualSection');
const manualCanvas = document.getElementById('manualCanvas');
const manualCtx = manualCanvas.getContext('2d');

// ===== Initialize =====
async function init() {
  loadingOverlay.classList.remove('hidden');
  loadingText.textContent = '正在加载 AI 模型 (1/2) — COCO-SSD 物体检测...';

  try {
    // Load COCO-SSD
    cocoModel = await cocoSsd.load();
    console.log('✅ COCO-SSD loaded');

    loadingText.textContent = '正在加载 AI 模型 (2/2) — MediaPipe 手部检测...';

    // Load MediaPipe Hands
    handsModel = new Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });
    handsModel.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });

    await new Promise((resolve) => {
      handsModel.onResults(() => resolve());
      // Send a dummy image to trigger initialization
      const dummyCanvas = document.createElement('canvas');
      dummyCanvas.width = 1; dummyCanvas.height = 1;
      handsModel.send({ image: dummyCanvas });
    });

    console.log('✅ MediaPipe Hands loaded');
    loadingOverlay.classList.add('hidden');
  } catch (err) {
    console.error('模型加载失败:', err);
    loadingText.textContent = '模型加载失败，请刷新页面重试';
  }
}

// ===== Upload =====
uploadCard.addEventListener('click', () => fileInput.click());
uploadCard.addEventListener('dragover', (e) => { e.preventDefault(); uploadCard.classList.add('dragover'); });
uploadCard.addEventListener('dragleave', () => uploadCard.classList.remove('dragover'));
uploadCard.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadCard.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', (e) => { if (e.target.files.length) handleFile(e.target.files[0]); });

function handleFile(file) {
  if (!file.type.startsWith('image/')) { alert('请上传图片文件'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    img = new Image();
    img.onload = () => {
      imgWidth = img.width;
      imgHeight = img.height;
      const maxW = Math.min(800, window.innerWidth - 40);
      displayScale = Math.min(1, maxW / imgWidth);
      analyzePhoto();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// ===== AI Analysis =====
async function analyzePhoto() {
  uploadSection.classList.add('hidden');
  analysisSection.classList.remove('hidden');
  resultSection.classList.add('hidden');
  manualSection.classList.add('hidden');

  // Step 1: Detect objects
  setStepActive('stepDetectObject');
  const objectPredictions = await cocoModel.detect(img);
  detectedObjects = objectPredictions.filter(p => p.score > 0.3);
  console.log('检测到的物体:', detectedObjects);
  setStepDone('stepDetectObject');

  // Step 2: Detect hands
  setStepActive('stepDetectHand');
  await detectHands();
  console.log('检测到的手:', detectedHands);
  setStepDone('stepDetectHand');

  // Step 3: Calculate scale
  setStepActive('stepCalcScale');
  calculateScale();
  setStepDone('stepCalcScale');

  // Step 4: Calculate object size
  setStepActive('stepCalcSize');
  calculateObjectSize();
  setStepDone('stepCalcSize');

  // Show results
  setTimeout(() => {
    analysisSection.classList.add('hidden');
    resultSection.classList.remove('hidden');
    drawResult();
  }, 500);
}

function setStepActive(id) {
  document.querySelectorAll('.a-step').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

function setStepDone(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.remove('active'); el.classList.add('done'); }
}

// ===== Hand Detection =====
async function detectHands() {
  detectedHands = [];

  // Create a temporary canvas for MediaPipe
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = imgWidth;
  tempCanvas.height = imgHeight;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(img, 0, 0);

  return new Promise((resolve) => {
    handsModel.onResults((results) => {
      if (results.multiHandLandmarks) {
        for (const landmarks of results.multiHandLandmarks) {
          // Calculate hand bounding box
          let minX = 1, minY = 1, maxX = 0, maxY = 0;
          for (const lm of landmarks) {
            minX = Math.min(minX, lm.x);
            minY = Math.min(minY, lm.y);
            maxX = Math.max(maxX, lm.x);
            maxY = Math.max(maxY, lm.y);
          }

          // Calculate middle finger length (landmark 9 = MCP, landmark 12 = tip)
          const mcp = landmarks[9];
          const tip = landmarks[12];
          const middleLengthPx = Math.hypot(
            (tip.x - mcp.x) * imgWidth,
            (tip.y - mcp.y) * imgHeight
          );

          // Calculate palm width (landmark 5 to landmark 17)
          const indexMcp = landmarks[5];
          const pinkyMcp = landmarks[17];
          const palmWidthPx = Math.hypot(
            (pinkyMcp.x - indexMcp.x) * imgWidth,
            (pinkyMcp.y - indexMcp.y) * imgHeight
          );

          detectedHands.push({
            bbox: { x: minX * imgWidth, y: minY * imgHeight, w: (maxX - minX) * imgWidth, h: (maxY - minY) * imgHeight },
            landmarks: landmarks,
            middleLengthPx: middleLengthPx,
            palmWidthPx: palmWidthPx
          });
        }
      }
      resolve();
    });

    handsModel.send({ image: tempCanvas });
  });
}

// ===== Calculate Scale =====
function calculateScale() {
  if (detectedHands.length === 0) {
    scalePxPerMm = null;
    return;
  }

  // Use the largest hand detected
  const hand = detectedHands.reduce((a, b) =>
    (a.middleLengthPx > b.middleLengthPx) ? a : b
  );

  // Get reference size from settings
  const age = document.getElementById('settingAge').value;
  const gender = document.getElementById('settingGender').value;
  const size = document.getElementById('settingHandSize').value;
  const customLength = parseFloat(document.getElementById('customFingerLength').value);

  let refMiddleMm;
  if (customLength && customLength > 0) {
    refMiddleMm = customLength * 10; // convert cm to mm
  } else {
    const base = handDatabase[age][gender].middle;
    refMiddleMm = base * handSizeMultiplier[size];
  }

  scalePxPerMm = hand.middleLengthPx / refMiddleMm;
}

// ===== Calculate Object Size =====
function calculateObjectSize() {
  if (!scalePxPerMm || detectedObjects.length === 0) {
    selectedObject = null;
    return;
  }

  // Select the largest detected object (or first if none significantly larger)
  selectedObject = detectedObjects.reduce((a, b) =>
    (a.bbox[2] * a.bbox[3] > b.bbox[2] * b.bbox[3]) ? a : b
  );

  const [x, y, w, h] = selectedObject.bbox;
  const realW = w / scalePxPerMm;
  const realH = h / scalePxPerMm;

  selectedObject.realWidth = realW;
  selectedObject.realHeight = realH;
}

// ===== Draw Result =====
function drawResult() {
  const canvas = resultCanvas;
  canvas.width = imgWidth * displayScale;
  canvas.height = imgHeight * displayScale;

  resultCtx.clearRect(0, 0, canvas.width, canvas.height);
  resultCtx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // Draw detected hands
  detectedHands.forEach((hand, i) => {
    const { x, y, w, h } = hand.bbox;
    resultCtx.strokeStyle = '#4f46e5';
    resultCtx.lineWidth = 2;
    resultCtx.setLineDash([5, 3]);
    resultCtx.strokeRect(x * displayScale, y * displayScale, w * displayScale, h * displayScale);
    resultCtx.setLineDash([]);

    // Label
    resultCtx.fillStyle = '#4f46e5';
    resultCtx.fillRect(x * displayScale, y * displayScale - 24, 70, 24);
    resultCtx.fillStyle = '#fff';
    resultCtx.font = 'bold 12px sans-serif';
    resultCtx.fillText(`手 #${i + 1}`, x * displayScale + 6, y * displayScale - 8);
  });

  // Draw detected object
  if (selectedObject) {
    const [x, y, w, h] = selectedObject.bbox;
    resultCtx.strokeStyle = '#16a34a';
    resultCtx.lineWidth = 3;
    resultCtx.strokeRect(x * displayScale, y * displayScale, w * displayScale, h * displayScale);

    // Label with class name
    const label = `${selectedObject.class} ${(selectedObject.score * 100).toFixed(0)}%`;
    resultCtx.fillStyle = '#16a34a';
    const textW = resultCtx.measureText(label).width + 16;
    resultCtx.fillRect(x * displayScale, y * displayScale - 28, textW, 28);
    resultCtx.fillStyle = '#fff';
    resultCtx.font = 'bold 13px sans-serif';
    resultCtx.fillText(label, x * displayScale + 8, y * displayScale - 10);

    // Dimensions
    const dimText = `${formatLength(selectedObject.realWidth)} × ${formatLength(selectedObject.realHeight)}`;
    resultCtx.fillStyle = '#16a34a';
    resultCtx.fillRect(x * displayScale, (y + h) * displayScale, resultCtx.measureText(dimText).width + 16, 26);
    resultCtx.fillStyle = '#fff';
    resultCtx.font = 'bold 12px sans-serif';
    resultCtx.fillText(dimText, x * displayScale + 8, (y + h) * displayScale + 18);
  }

  // Update text results
  updateResultText();
}

function updateResultText() {
  if (selectedObject) {
    document.getElementById('detectedObject').textContent =
      `${selectedObject.class} (${(selectedObject.score * 100).toFixed(0)}% 置信度)`;
  } else {
    document.getElementById('detectedObject').textContent = '未检测到物体';
  }

  if (detectedHands.length > 0) {
    const age = document.getElementById('settingAge').value;
    const gender = document.getElementById('settingGender').value;
    const custom = document.getElementById('customFingerLength').value;
    let text = `检测到 ${detectedHands.length} 只手`;
    if (custom && custom > 0) {
      text += ` · 使用自定义尺寸 ${custom}cm`;
    } else {
      const ageLabels = { adult: '成年人', elderly: '老年人', teen: '青少年', child: '儿童' };
      text += ` · ${ageLabels[age]}${gender === 'male' ? '男性' : '女性'}`;
    }
    document.getElementById('detectedHand').textContent = text;
  } else {
    document.getElementById('detectedHand').textContent = '未检测到手（无法计算比例尺）';
  }

  if (selectedObject && selectedObject.realWidth) {
    document.getElementById('objectWidth').innerHTML = formatLength(selectedObject.realWidth);
    document.getElementById('objectHeight').innerHTML = formatLength(selectedObject.realHeight);
  } else {
    document.getElementById('objectWidth').textContent = '—';
    document.getElementById('objectHeight').textContent = '—';
  }

  if (scalePxPerMm) {
    document.getElementById('scaleInfo').textContent = `1 mm = ${scalePxPerMm.toFixed(2)} 像素`;
  } else {
    document.getElementById('scaleInfo').textContent = '未设定';
  }

  const custom = document.getElementById('customFingerLength').value;
  document.getElementById('precisionInfo').textContent =
    custom && custom > 0 ? '±10~15%（自定义精确值）' : '±15~25%（平均值估算）';
}

function formatLength(mm) {
  if (mm >= 1000) return `${(mm / 1000).toFixed(2)} <span class="unit">m</span>`;
  if (mm >= 100) return `${(mm / 10).toFixed(1)} <span class="unit">cm</span>`;
  return `${mm.toFixed(1)} <span class="unit">mm</span>`;
}

// ===== Manual Adjust =====
document.getElementById('btnManualAdjust').addEventListener('click', () => {
  resultSection.classList.add('hidden');
  manualSection.classList.remove('hidden');
  initManualCanvas();
});

document.getElementById('btnBackToResult').addEventListener('click', () => {
  manualSection.classList.add('hidden');
  resultSection.classList.remove('hidden');
});

function initManualCanvas() {
  const canvas = manualCanvas;
  canvas.width = imgWidth * displayScale;
  canvas.height = imgHeight * displayScale;
  manualPoints = [];
  drawManualCanvas();
}

function drawManualCanvas() {
  manualCtx.clearRect(0, 0, manualCanvas.width, manualCanvas.height);
  manualCtx.drawImage(img, 0, 0, manualCanvas.width, manualCanvas.height);

  // Draw existing AI detection as reference
  if (selectedObject) {
    const [x, y, w, h] = selectedObject.bbox;
    manualCtx.strokeStyle = 'rgba(22, 163, 74, 0.3)';
    manualCtx.lineWidth = 2;
    manualCtx.setLineDash([3, 3]);
    manualCtx.strokeRect(x * displayScale, y * displayScale, w * displayScale, h * displayScale);
    manualCtx.setLineDash([]);
  }

  // Draw manual points
  manualPoints.forEach((p, i) => {
    manualCtx.beginPath();
    manualCtx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    manualCtx.fillStyle = '#dc2626';
    manualCtx.fill();
    manualCtx.beginPath();
    manualCtx.arc(p.x, p.y, 10, 0, Math.PI * 2);
    manualCtx.strokeStyle = '#dc2626';
    manualCtx.lineWidth = 2;
    manualCtx.stroke();

    // Label
    manualCtx.fillStyle = '#dc2626';
    manualCtx.font = 'bold 12px sans-serif';
    manualCtx.fillText(i + 1, p.x + 12, p.y - 12);
  });

  // Draw polygon if 4 points
  if (manualPoints.length === 4) {
    manualCtx.beginPath();
    manualCtx.moveTo(manualPoints[0].x, manualPoints[0].y);
    for (let i = 1; i < 4; i++) {
      manualCtx.lineTo(manualPoints[i].x, manualPoints[i].y);
    }
    manualCtx.closePath();
    manualCtx.strokeStyle = '#dc2626';
    manualCtx.lineWidth = 2;
    manualCtx.setLineDash([5, 3]);
    manualCtx.stroke();
    manualCtx.setLineDash([]);
  }
}

manualCanvas.addEventListener('click', (e) => {
  if (manualPoints.length >= 4) manualPoints = [];
  const rect = manualCanvas.getBoundingClientRect();
  manualPoints.push({
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  });
  drawManualCanvas();
});

document.getElementById('btnManualReset').addEventListener('click', () => {
  manualPoints = [];
  drawManualCanvas();
});

document.getElementById('btnManualCalc').addEventListener('click', () => {
  if (manualPoints.length !== 4 || !scalePxPerMm) {
    alert('请先标定4个点，并确保已检测到手部');
    return;
  }

  // Calculate width and height from 4 points
  const p = manualPoints;
  const w1 = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y);
  const w2 = Math.hypot(p[2].x - p[3].x, p[2].y - p[3].y);
  const h1 = Math.hypot(p[3].x - p[0].x, p[3].y - p[0].y);
  const h2 = Math.hypot(p[2].x - p[1].x, p[2].y - p[1].y);

  const avgW = ((w1 + w2) / 2) / displayScale / scalePxPerMm;
  const avgH = ((h1 + h2) / 2) / displayScale / scalePxPerMm;

  selectedObject = {
    ...selectedObject,
    realWidth: avgW,
    realHeight: avgH,
    bbox: [
      Math.min(p[0].x, p[1].x, p[2].x, p[3].x) / displayScale,
      Math.min(p[0].y, p[1].y, p[2].y, p[3].y) / displayScale,
      Math.abs(Math.max(p[0].x, p[1].x, p[2].x, p[3].x) - Math.min(p[0].x, p[1].x, p[2].x, p[3].x)) / displayScale,
      Math.abs(Math.max(p[0].y, p[1].y, p[2].y, p[3].y) - Math.min(p[0].y, p[1].y, p[2].y, p[3].y)) / displayScale
    ]
  };

  manualSection.classList.add('hidden');
  resultSection.classList.remove('hidden');
  drawResult();
});

// ===== Reanalyze =====
document.getElementById('btnReanalyze').addEventListener('click', () => {
  analyzePhoto();
});

// ===== New Photo =====
document.getElementById('btnNewPhoto2').addEventListener('click', () => {
  resultSection.classList.add('hidden');
  manualSection.classList.add('hidden');
  uploadSection.classList.remove('hidden');
  fileInput.value = '';
  detectedObjects = [];
  detectedHands = [];
  scalePxPerMm = null;
  selectedObject = null;
});

// ===== Settings Change =====
document.getElementById('settingAge').addEventListener('change', () => {
  if (selectedObject) { calculateScale(); calculateObjectSize(); drawResult(); }
});
document.getElementById('settingGender').addEventListener('change', () => {
  if (selectedObject) { calculateScale(); calculateObjectSize(); drawResult(); }
});
document.getElementById('settingHandSize').addEventListener('change', () => {
  if (selectedObject) { calculateScale(); calculateObjectSize(); drawResult(); }
});
document.getElementById('customFingerLength').addEventListener('input', () => {
  if (selectedObject) { calculateScale(); calculateObjectSize(); drawResult(); }
});

// ===== Start =====
init();
