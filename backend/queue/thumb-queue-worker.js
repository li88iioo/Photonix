const { Worker } = require('bullmq');
const path = require('path');
const fs = require('fs').promises;
const winston = require('winston');
const sharp = require('sharp');
const { bullConnection } = require('../config/redis');
const { THUMBS_DIR, PHOTOS_DIR, THUMBNAIL_QUEUE_NAME } = require('../config');

// Configure logging
const logger = winston.createLogger({
	level: process.env.LOG_LEVEL || 'info',
	format: winston.format.combine(
		winston.format.colorize(),
		winston.format.timestamp(),
		winston.format.printf(info => `[${info.timestamp}] [THUMB-QUEUE] ${info.level}: ${info.message}`)
	),
	transports: [new winston.transports.Console()]
});

// Limit sharp cache and concurrency to reduce memory for large libraries
try {
	const memMb = Number(process.env.SHARP_CACHE_MEMORY_MB || 32);
	const items = Number(process.env.SHARP_CACHE_ITEMS || 100);
	const files = Number(process.env.SHARP_CACHE_FILES || 0);
	sharp.cache({ memory: memMb, items, files });
	const conc = Number(process.env.SHARP_CONCURRENCY || 1);
	if (conc > 0) sharp.concurrency(conc);
} catch {}

function translateErrorMessage(message = '') {
	const msg = String(message || '').toLowerCase();
	if (msg.includes('webp') && (msg.includes('unable to parse image') || msg.includes('corrupt header'))) {
		return 'WebP 文件头损坏或格式异常，无法解析';
	}
	if (msg.includes('invalid marker') || msg.includes('jpeg')) {
		return 'JPEG 文件损坏或不完整，无法解析';
	}
	if (msg.includes('png') && (msg.includes('bad') || msg.includes('invalid'))) {
		return 'PNG 文件损坏或格式异常，无法解析';
	}
	return message || '无法解析的图片文件';
}

async function generateImageThumbnail(imagePath, thumbPath) {
	const metadata = await sharp(imagePath, { limitInputPixels: Number(process.env.SHARP_MAX_PIXELS || (24000 * 24000)) }).metadata();
	const pixelCount = (metadata.width || 1) * (metadata.height || 1);
	const MAX_PIXELS = 100000000;
	if (pixelCount > MAX_PIXELS) {
		throw new Error(`图片尺寸过大: ${metadata.width}x${metadata.height} (${pixelCount.toLocaleString()} 像素)`);
	}
	let quality = 80;
	if (pixelCount > 8000000) quality = 65; else if (pixelCount > 2000000) quality = 70;
	await sharp(imagePath, { limitInputPixels: Number(process.env.SHARP_MAX_PIXELS || (24000 * 24000)) })
		.resize({ width: 500 })
		.webp({ quality })
		.toFile(thumbPath);
}

async function processThumbJob(job) {
	const { filePath, relativePath, type } = job.data || {};
	if (!filePath || !relativePath) {
		throw new Error('缺少必要参数 filePath/relativePath');
	}
	const isVideo = type === 'video' || /\.(mp4|webm|mov)$/i.test(relativePath);
	const extension = isVideo ? '.jpg' : '.webp';
	const thumbRelPath = relativePath.replace(/\.[^.]+$/, extension);
	const thumbPath = path.join(THUMBS_DIR, thumbRelPath);
	const srcPath = path.isAbsolute(filePath) ? filePath : path.join(PHOTOS_DIR, relativePath);

	// Skip if exists
	try { await fs.access(thumbPath); return { skipped: true }; } catch {}
	await fs.mkdir(path.dirname(thumbPath), { recursive: true });
	try {
		if (isVideo) {
			// Use ffmpeg to grab one frame; keep consistent with existing worker
			const { execFile } = require('child_process');
			await new Promise((resolve, reject) => {
				execFile('ffmpeg', ['-v','error','-y','-i', srcPath, '-vf', 'thumbnail=300,scale=320:-2', '-frames:v','1', thumbPath], (err) => err ? reject(err) : resolve());
			});
		} else {
			await generateImageThumbnail(srcPath, thumbPath);
		}
		logger.info(`生成完成: ${relativePath}`);
		return { success: true };
	} catch (e) {
		const msg = translateErrorMessage(e && e.message);
		logger.warn(`生成失败: ${relativePath} - ${msg}`);
		throw e;
	}
}

// Start queue worker
new Worker(
	THUMBNAIL_QUEUE_NAME,
	async (job) => {
		return await processThumbJob(job);
	},
	{ connection: bullConnection, concurrency: Number(process.env.THUMB_QUEUE_CONCURRENCY || 1) }
);

logger.info(`Thumbnail queue worker started. Queue=${THUMBS_DIR}`);
