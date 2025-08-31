const { Worker } = require('bullmq');
const path = require('path');
const { promises: fs, constants: FS_CONST } = require('fs');
const winston = require('winston');
const util = require('util');
const { exec } = require('child_process');
const execPromise = util.promisify(exec);
const { bullConnection } = require('../config/redis');
const { PHOTOS_DIR, THUMBS_DIR, VIDEO_QUEUE_NAME } = require('../config');

const logger = winston.createLogger({
	level: process.env.LOG_LEVEL || 'info',
	format: winston.format.combine(
		winston.format.colorize(),
		winston.format.timestamp(),
		winston.format.printf(info => `[${info.timestamp}] [VIDEO-QUEUE] ${info.level}: ${info.message}`)
	),
	transports: [new winston.transports.Console()]
});

async function checkHlsExists(rel) {
	try {
		const master = path.join(THUMBS_DIR, 'hls', rel, 'master.m3u8');
		await fs.access(master);
		return true;
	} catch { return false; }
}

async function detectRotationDegrees(input) {
	try {
		const { stdout } = await execPromise(`ffprobe -v error -select_streams v:0 -show_entries stream_tags=rotate:stream_side_data=displaymatrix -of json "${input}"`);
		const data = JSON.parse(stdout || '{}');
		let angle = 0;
		const streams = Array.isArray(data.streams) ? data.streams : [];
		if (streams.length > 0) {
			const tags = streams[0].tags || {};
			if (tags.rotate) {
				const v = parseInt(String(tags.rotate).trim(), 10);
				if (!Number.isNaN(v)) angle = v;
			}
			const sdl = streams[0].side_data_list || [];
			for (const sd of sdl) {
				if (sd && typeof sd.rotation !== 'undefined') {
					const r = parseFloat(sd.rotation);
					if (!Number.isNaN(r) && Math.abs(r) > Math.abs(angle)) angle = r;
				}
			}
		}
		let norm = ((Math.round(angle) % 360) + 360) % 360;
		return norm;
	} catch { return 0; }
}

async function getFfmpegTuning() {
	try {
		const Redis = require('ioredis');
		const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
		const [threadsStr, preset] = await redis.mget('adaptive:ffmpeg_threads', 'adaptive:ffmpeg_preset');
		try { redis.disconnect(); } catch {}
		const threads = Math.max(1, parseInt(threadsStr || '1', 10));
		const presetFinal = (preset || process.env.FFMPEG_PRESET || 'veryfast');
		return { threads, preset: presetFinal };
	} catch {
		return { threads: Math.max(1, parseInt(process.env.FFMPEG_THREADS || '1', 10)), preset: (process.env.FFMPEG_PRESET || 'veryfast') };
	}
}

async function processVideoJob(job) {
	const { relativePath } = job.data || {};
	if (!relativePath) throw new Error('缺少 relativePath');
	const filePath = path.join(PHOTOS_DIR, relativePath);
	const hlsOutputDir = path.join(THUMBS_DIR, 'hls', relativePath);
	if (await checkHlsExists(relativePath)) return { skipped: true };
	await fs.mkdir(hlsOutputDir, { recursive: true });
	const targetDir = path.dirname(filePath);
	const tempDir = path.join(thumbsDir, 'temp', relativePath);
	const tempPath = path.join(tempDir, `temp_opt_${path.basename(filePath)}`);
	await fs.mkdir(tempDir, { recursive: true });

	// 跳过MOOV atom优化，保持原文件不变
	logger.info(`跳过MOOV atom优化，保持原文件不变: ${filePath}`);

	const rotation = await detectRotationDegrees(filePath);
	let rotateFilter = '';
	if (rotation === 90) rotateFilter = 'transpose=1';
	else if (rotation === 270) rotateFilter = 'transpose=2';
	else if (rotation === 180) rotateFilter = 'hflip,vflip';
	const ffCfg = await getFfmpegTuning();
	const resolutions = [
		{ name: '480p', width: 854, height: 480, bandwidth: '1500000' },
		{ name: '720p', width: 1280, height: 720, bandwidth: '2800000' }
	];
	for (const res of resolutions) {
		const resDir = path.join(hlsOutputDir, res.name);
		await fs.mkdir(resDir, { recursive: true });
		const baseScaleCrop = `scale=${res.width}:${res.height}:force_original_aspect_ratio=increase:eval=frame,crop=${res.width}:${res.height}`;
		const vfChain = [rotateFilter, baseScaleCrop, 'setsar=1'].filter(Boolean).join(',');
		const segmentPattern = path.join(resDir, 'segment_%05d.ts');
		const cmd = `ffmpeg -v error -y -threads ${ffCfg.threads} -i "${filePath}" -vf "${vfChain}" -c:v libx264 -pix_fmt yuv420p -profile:v baseline -level 3.0 -preset ${ffCfg.preset} -crf 23 -c:a aac -ar 48000 -ac 2 -b:a 128k -metadata:s:v:0 rotate=0 -start_number 0 -hls_time 10 -hls_flags independent_segments -hls_segment_filename "${segmentPattern}" -hls_list_size 0 -f hls "${path.join(resDir, 'stream.m3u8')}"`;
		await execPromise(cmd);
	}
	const masterPlaylistContent = resolutions.map(res => `#EXT-X-STREAM-INF:BANDWIDTH=${res.bandwidth},RESOLUTION=${res.width}x${res.height}\n${res.name}/stream.m3u8`).join('\n');
	const masterPlaylist = `#EXTM3U\n${masterPlaylistContent}`;
	await fs.writeFile(path.join(hlsOutputDir, 'master.m3u8'), masterPlaylist);
	try {
		const { createHlsRecord } = require('../utils/hls.utils');
		await createHlsRecord(relativePath, {
			resolutions: resolutions.map(r => r.name),
			fileSize: await fs.stat(filePath).then(s => s.size).catch(() => 0),
			processingTime: 0
		});
	} catch {}
	return { success: true };
}

new Worker(
	VIDEO_QUEUE_NAME,
	async (job) => {
		return await processVideoJob(job);
	},
	{ connection: bullConnection, concurrency: Number(process.env.VIDEO_QUEUE_CONCURRENCY || 1) }
);

logger.info('Video queue worker started.');
