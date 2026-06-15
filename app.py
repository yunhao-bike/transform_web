import threading
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pdf2docx import Converter
from pydantic import BaseModel

# 项目根目录 = 网页根目录（部署时整个文件夹对应域名根路径）
BASE_DIR = Path(__file__).resolve().parent

# 前端页面：浏览器通过 / 、/style.css 、/app.js 访问
STATIC_DIR = BASE_DIR / "static"

# 后端私有存储：不对外暴露 URL，仅 app.py 读写
STORAGE_DIR = BASE_DIR / "storage"
UPLOAD_DIR = STORAGE_DIR / "uploads"
OUTPUT_DIR = STORAGE_DIR / "outputs"

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="PDF 转 Word 工具")

tasks: dict[str, dict] = {}
tasks_lock = threading.Lock()


class TaskStatus(BaseModel):
    task_id: str
    status: Literal["uploading", "converting", "completed", "failed"]
    upload_progress: int
    convert_progress: int
    message: str
    original_name: str | None = None
    output_name: str | None = None
    error: str | None = None


def cleanup_old_files() -> None:
    cutoff = datetime.now() - timedelta(hours=2)
    for folder in (UPLOAD_DIR, OUTPUT_DIR):
        for path in folder.iterdir():
            if path.is_file():
                modified = datetime.fromtimestamp(path.stat().st_mtime)
                if modified < cutoff:
                    path.unlink(missing_ok=True)


def update_task(task_id: str, **fields) -> None:
    with tasks_lock:
        if task_id in tasks:
            tasks[task_id].update(fields)


def convert_pdf_to_word(task_id: str, pdf_path: Path, docx_path: Path) -> None:
    try:
        update_task(
            task_id,
            status="converting",
            convert_progress=5,
            message="正在解析 PDF 文件...",
        )

        converter = Converter(str(pdf_path))
        try:
            page_count = len(converter.fitz_doc)
            if page_count == 0:
                raise ValueError("PDF 文件没有可转换的页面")

            update_task(
                task_id,
                convert_progress=10,
                message=f"共 {page_count} 页，开始转换...",
            )

            for page_index in range(page_count):
                converter.convert(str(docx_path), start=page_index, end=page_index)
                progress = 10 + int(((page_index + 1) / page_count) * 85)
                update_task(
                    task_id,
                    convert_progress=progress,
                    message=f"正在转换第 {page_index + 1}/{page_count} 页...",
                )
        finally:
            converter.close()

        update_task(
            task_id,
            status="completed",
            convert_progress=100,
            message="转换完成，可以下载 Word 文件",
            output_name=docx_path.name,
        )
    except Exception as exc:
        update_task(
            task_id,
            status="failed",
            convert_progress=0,
            message="转换失败",
            error=str(exc),
        )
        if docx_path.exists():
            docx_path.unlink(missing_ok=True)


@app.on_event("startup")
def on_startup() -> None:
    cleanup_old_files()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/upload")
async def upload_pdf(file: UploadFile = File(...)) -> dict[str, str]:
    if not file.filename:
        raise HTTPException(status_code=400, detail="请选择要上传的文件")

    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="仅支持 PDF 文件")

    cleanup_old_files()

    task_id = str(uuid.uuid4())
    safe_name = Path(file.filename).name
    pdf_path = UPLOAD_DIR / f"{task_id}.pdf"
    docx_path = OUTPUT_DIR / f"{task_id}.docx"

    with tasks_lock:
        tasks[task_id] = {
            "task_id": task_id,
            "status": "uploading",
            "upload_progress": 0,
            "convert_progress": 0,
            "message": "正在上传文件...",
            "original_name": safe_name,
            "output_name": None,
            "error": None,
        }

    content = await file.read()
    if not content:
        update_task(
            task_id,
            status="failed",
            message="上传失败",
            error="文件内容为空",
        )
        raise HTTPException(status_code=400, detail="文件内容为空")

    pdf_path.write_bytes(content)
    update_task(
        task_id,
        status="converting",
        upload_progress=100,
        message="上传完成，准备开始转换...",
    )

    thread = threading.Thread(
        target=convert_pdf_to_word,
        args=(task_id, pdf_path, docx_path),
        daemon=True,
    )
    thread.start()

    return {"task_id": task_id}


@app.get("/api/status/{task_id}", response_model=TaskStatus)
def get_status(task_id: str) -> TaskStatus:
    with tasks_lock:
        task = tasks.get(task_id)

    if not task:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")

    return TaskStatus(**task)


@app.get("/api/download/{task_id}")
def download_word(task_id: str):
    with tasks_lock:
        task = tasks.get(task_id)

    if not task:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")

    if task["status"] != "completed":
        raise HTTPException(status_code=400, detail="文件尚未转换完成")

    docx_path = OUTPUT_DIR / f"{task_id}.docx"
    if not docx_path.exists():
        raise HTTPException(status_code=404, detail="Word 文件不存在")

    original_stem = Path(task.get("original_name") or "document").stem
    download_name = f"{original_stem}.docx"

    return FileResponse(
        path=docx_path,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename=download_name,
    )


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
