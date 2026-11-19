// 从 output/reference-1~3 生成 README 里用的素材，写到 assets/。先用 paint.mjs 把三张示例图画出来再运行：
//   node scripts/readme-media.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ffmpeg from "ffmpeg-static";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const at = (...parts) => path.join(root, ...parts);
const EXAMPLES = ["reference-1", "reference-2", "reference-3"], FEATURED = "reference-2";
const PREVIEW = { width: 560, fps: 12, speed: 1.6, quality: "70", hold: 2.5 };
const quiet = ["-y", "-loglevel", "error"];
const size = async f => ((await stat(f)).size / 1048576).toFixed(2) + " MB";

for (const name of EXAMPLES) {
  if (!existsSync(at("output", name, "frames"))) {
    console.error(`缺少 output/${name}，请先运行 node paint.mjs reference-image/${name}.<扩展名>`);
    process.exit(1);
  }
}
await mkdir(at("assets"), { recursive: true });

for (const name of EXAMPLES) {
  const frames = ["-framerate", "30", "-i", at("output", name, "frames", "frame_%04d.jpg")], out = at("assets", name);

  // 完整过程视频：内容和 output 里的一样，压得小一些
  await run(ffmpeg, [...quiet, ...frames, "-vf", "crop=trunc(iw/2)*2:trunc(ih/2)*2,tpad=stop_mode=clone:stop_duration=3",
    "-c:v", "libx264", "-preset", "slow", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out + ".mp4"]);

  // README 里自动播放的预览：缩小、加速，画完后停一会儿再循环
  await run(ffmpeg, [...quiet, ...frames,
    "-vf", `setpts=PTS/${PREVIEW.speed},fps=${PREVIEW.fps},scale=${PREVIEW.width}:-2:flags=lanczos,tpad=stop_mode=clone:stop_duration=${PREVIEW.hold}`,
    "-c:v", "libwebp_anim", "-lossless", "0", "-q:v", PREVIEW.quality, "-compression_level", "6", "-loop", "0", out + ".webp"]);

  await run(ffmpeg, [...quiet, "-i", at("output", name, "final-1x.png"), "-q:v", "3", out + "-painted.jpg"]);
  console.log(`${name}：mp4 ${await size(out + ".mp4")}，webp ${await size(out + ".webp")}，成图 ${await size(out + "-painted.jpg")}`);
}

await copyFile(at("output", FEATURED, "process-sheet.jpg"), at("assets", FEATURED + "-passes.jpg"));
// 笔触特写：从两倍尺寸的成图里原样裁一块
await run(ffmpeg, [...quiet, "-i", at("output", FEATURED, "final.png"), "-vf", "crop=1400:700:560:300", "-q:v", "3", at("assets", FEATURED + "-closeup.jpg")]);
console.log(`${FEATURED}：过程一览和笔触特写已生成`);
