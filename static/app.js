const BASE_PATH = (window.APP_CONFIG && window.APP_CONFIG.BASE_PATH) || "";

function apiPath(path) {
  return `${BASE_PATH}${path}`;
}

const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const fileName = document.getElementById("fileName");
const convertBtn = document.getElementById("convertBtn");
const progressPanel = document.getElementById("progressPanel");
const uploadBar = document.getElementById("uploadBar");
const convertBar = document.getElementById("convertBar");
const uploadPercent = document.getElementById("uploadPercent");
const convertPercent = document.getElementById("convertPercent");
const statusBox = document.getElementById("statusBox");
const statusIcon = document.getElementById("statusIcon");
const statusText = document.getElementById("statusText");
const downloadBtn = document.getElementById("downloadBtn");

let selectedFile = null;
let currentTaskId = null;
let pollTimer = null;

function setStatus(type, message, icon = "•") {
  statusBox.classList.remove("hidden", "success", "error", "info");
  statusBox.classList.add(type);
  statusIcon.textContent = icon;
  statusText.textContent = message;
}

function resetProgress() {
  uploadBar.style.width = "0%";
  convertBar.style.width = "0%";
  uploadPercent.textContent = "0%";
  convertPercent.textContent = "0%";
}

function setUploadProgress(value) {
  const percent = Math.max(0, Math.min(100, value));
  uploadBar.style.width = `${percent}%`;
  uploadPercent.textContent = `${percent}%`;
}

function setConvertProgress(value) {
  const percent = Math.max(0, Math.min(100, value));
  convertBar.style.width = `${percent}%`;
  convertPercent.textContent = `${percent}%`;
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function updateSelectedFile(file) {
  if (!file) {
    return;
  }

  if (!file.name.toLowerCase().endsWith(".pdf")) {
    setStatus("error", "请选择 PDF 文件", "!");
    return;
  }

  selectedFile = file;
  fileName.textContent = file.name;
  convertBtn.disabled = false;
  downloadBtn.classList.add("hidden");
  setStatus("info", "文件已选择，点击“开始转换”", "i");
}

function uploadWithProgress(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append("file", file);

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) {
        return;
      }
      const percent = Math.round((event.loaded / event.total) * 100);
      setUploadProgress(percent);
      setStatus("info", `正在上传文件... ${percent}%`, "↑");
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (error) {
          reject(new Error("服务器返回了无效数据"));
        }
        return;
      }

      let message = "上传失败";
      try {
        const data = JSON.parse(xhr.responseText);
        message = data.detail || message;
      } catch (error) {
        // ignore parse error
      }
      reject(new Error(message));
    });

    xhr.addEventListener("error", () => reject(new Error("网络错误，上传失败")));
    xhr.addEventListener("abort", () => reject(new Error("上传已取消")));

    xhr.open("POST", apiPath("/api/upload"));
    xhr.send(formData);
  });
}

async function pollTaskStatus(taskId) {
  const response = await fetch(apiPath(`/api/status/${taskId}`));
  if (!response.ok) {
    throw new Error("无法获取转换状态");
  }
  return response.json();
}

function startPolling(taskId) {
  stopPolling();

  pollTimer = setInterval(async () => {
    try {
      const task = await pollTaskStatus(taskId);

      setUploadProgress(task.upload_progress);
      setConvertProgress(task.convert_progress);

      if (task.status === "converting") {
        setStatus("info", task.message, "↻");
      }

      if (task.status === "completed") {
        stopPolling();
        setConvertProgress(100);
        setStatus("success", task.message, "✓");
        downloadBtn.classList.remove("hidden");
        convertBtn.disabled = false;
      }

      if (task.status === "failed") {
        stopPolling();
        setStatus("error", task.error || task.message, "!");
        convertBtn.disabled = false;
      }
    } catch (error) {
      stopPolling();
      setStatus("error", error.message, "!");
      convertBtn.disabled = false;
    }
  }, 800);
}

async function startConversion() {
  if (!selectedFile) {
    setStatus("error", "请先选择 PDF 文件", "!");
    return;
  }

  stopPolling();
  resetProgress();
  progressPanel.classList.remove("hidden");
  downloadBtn.classList.add("hidden");
  convertBtn.disabled = true;
  currentTaskId = null;

  setStatus("info", "准备上传文件...", "↑");

  try {
    const result = await uploadWithProgress(selectedFile);
    currentTaskId = result.task_id;
    setUploadProgress(100);
    setStatus("info", "上传完成，正在转换...", "↻");
    startPolling(currentTaskId);
  } catch (error) {
    setStatus("error", error.message, "!");
    convertBtn.disabled = false;
  }
}

function downloadResult() {
  if (!currentTaskId) {
    setStatus("error", "没有可下载的文件", "!");
    return;
  }

  window.location.href = apiPath(`/api/download/${currentTaskId}`);
}

dropZone.addEventListener("click", () => fileInput.click());

dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  updateSelectedFile(file);
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragover");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragover");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragover");
  const file = event.dataTransfer.files[0];
  updateSelectedFile(file);
});

convertBtn.addEventListener("click", startConversion);
downloadBtn.addEventListener("click", downloadResult);
