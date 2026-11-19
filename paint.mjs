#!/usr/bin/env node
// 给一张参考图，用代码画笔把它一笔一笔重画出来：
//   node paint.mjs <参考图> [选项]
// 先生成可双击运行的单文件 painting.html，再用本机 Chrome 逐帧作画，导出逐帧图片、过程视频和成图。
import { readFile, writeFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const run = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const SIZE_MIN = 800, SIZE_MAX = 1600, HOLD_SECONDS = 3;

const USAGE = `用法：node paint.mjs <参考图> [选项]

  --out <目录>      输出目录（默认 output/<图片名>）
  --size <像素>     作画时长边的像素数（默认用原图尺寸，超出 ${SIZE_MIN}–${SIZE_MAX} 时缩放到这个范围内）
  --passes <1-6>    只画前几遍；越少越写意，默认画满 6 遍
  --seed <整数>     随机种子，换一个就是另一种笔触排布
  --config <文件>   这张图的设置（默认读图片旁边的 <图片名>.paint.json，没有就全自动）
  --no-config       忽略图片旁边的 .paint.json
  --html-only       只生成 painting.html，不导出逐帧图片和视频
  --chrome <路径>   Chrome 可执行文件的位置（也可以用环境变量 CHROME_PATH）`;

class UserError extends Error {}

function parseCli() {
  let cli;
  try {
    cli = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: "string" }, size: { type: "string" }, passes: { type: "string" }, seed: { type: "string" },
        config: { type: "string" }, "no-config": { type: "boolean" }, "html-only": { type: "boolean" },
        chrome: { type: "string" }, help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    throw new UserError(e.message + "\n\n" + USAGE);
  }
  if (cli.values.help) { console.log(USAGE); process.exit(0); }
  if (cli.positionals.length !== 1) throw new UserError(USAGE);
  const int = (name, lo, hi) => {
    if (cli.values[name] == null) return undefined;
    const v = Number(cli.values[name]);
    if (!Number.isInteger(v) || v < lo || v > hi) throw new UserError(`--${name} 应当是 ${lo} 到 ${hi} 之间的整数`);
    return v;
  };
  return { ...cli.values, image: path.resolve(cli.positionals[0]), size: int("size", 64, 4000), passes: int("passes", 1, 6), seed: int("seed", 0, 2 ** 31 - 1) };
}

function sniff(buf) {
  const ascii = (a, b) => buf.toString("latin1", a, b);
  if (buf[0] === 0xFF && buf[1] === 0xD8) return "image/jpeg";
  if (ascii(1, 4) === "PNG") return "image/png";
  if (ascii(0, 3) === "GIF") return "image/gif";
  if (ascii(0, 2) === "BM") return "image/bmp";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp") return /^avi[fs]/.test(ascii(8, 12)) ? "image/avif" : "heic";
  return null;
}

async function loadImage(file) {
  if (!existsSync(file)) throw new UserError("找不到图片：" + file);
  let bytes = await readFile(file), mime = sniff(bytes);
  if (mime === "heic") {            // Chrome 不认 HEIC，macOS 上借系统自带的 sips 转一下
    if (process.platform !== "darwin") throw new UserError("HEIC 图片只在 macOS 上支持，请先转成 JPG 或 PNG");
    const tmp = await mkdtemp(path.join(tmpdir(), "paint-"));
    try {
      await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "95", file, "--out", path.join(tmp, "ref.jpg")]);
      bytes = await readFile(path.join(tmp, "ref.jpg")); mime = "image/jpeg";
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  if (!mime) throw new UserError("认不出这个文件的图片格式（支持 JPG、PNG、WebP、GIF、AVIF、BMP，macOS 上还支持 HEIC）");
  return { bytes, mime };
}

async function loadConfig(opts) {
  const sidecar = opts.image.replace(/\.[^./\\]+$/, "") + ".paint.json";
  const file = opts["no-config"] ? null : opts.config ? path.resolve(opts.config) : existsSync(sidecar) ? sidecar : null;
  let config = {};
  if (file) {
    try { config = JSON.parse(await readFile(file, "utf8")); }
    catch (e) { throw new UserError("读不了设置文件 " + file + "：" + e.message); }
    const pair = v => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
    const bad = what => { throw new UserError(file + " 里的 " + what + " 格式不对，写法见 README"); };
    if (config === null || typeof config !== "object" || Array.isArray(config)) bad("内容");
    if (config.center != null && !pair(config.center)) bad("center");
    for (const key of ["focus", "glints"]) {
      if (config[key] != null && !Array.isArray(config[key])) bad(key);
      for (const item of config[key] || []) if (!item || !pair(item.c) || (key === "focus" && !pair(item.r))) bad(key);
    }
  }
  if (opts.seed != null) config.seed = opts.seed;
  if (opts.passes != null) config.passes = opts.passes;
  return { config, file };
}

function findChrome(explicit) {
  if (explicit && !existsSync(explicit)) throw new UserError("--chrome 指向的文件不存在：" + explicit);
  const found = [
    explicit, process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find(p => p && existsSync(p));
  if (!found) throw new UserError("找不到 Chrome。请安装 Chrome，或用 --chrome <路径> / 环境变量 CHROME_PATH 指明它的位置");
  return found;
}

async function findFfmpeg() {
  try {
    const bundled = (await import("ffmpeg-static")).default;
    if (bundled && existsSync(bundled)) return bundled;
  } catch {}
  try { await run("ffmpeg", ["-version"]); return "ffmpeg"; } catch {}
  return null;
}

// 在浏览器里解码参考图并定下作画尺寸；尺寸不用变就原样内嵌，否则缩放后重新编码
async function prepareReference(page, { bytes, mime }, size) {
  const original = "data:" + mime + ";base64," + bytes.toString("base64");
  const ref = await page.evaluate(async (src, size, lo, hi) => {
    const img = new Image();
    img.src = src;
    try { await img.decode(); } catch { return null; }
    const w0 = img.naturalWidth, h0 = img.naturalHeight, long = Math.max(w0, h0);
    const target = size || Math.min(hi, Math.max(lo, long));
    if (target === long) return { width: w0, height: h0, original: [w0, h0] };
    const k = target / long, w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, w, h);
    x.imageSmoothingQuality = "high";
    x.drawImage(img, 0, 0, w, h);
    return { width: w, height: h, original: [w0, h0], url: c.toDataURL("image/jpeg", 0.95) };
  }, original, size || 0, SIZE_MIN, SIZE_MAX);
  if (!ref) throw new UserError("Chrome 解码不了这张图片，文件可能已损坏");
  return { ...ref, url: ref.url || original };
}

function buildHtml(template, values) {
  for (const key of Object.keys(values)) {
    if (template.split("__" + key + "__").length !== 2) throw new Error("模板里应当恰好有一个 __" + key + "__");
  }
  return template.replace(/__([A-Z_]+?)__/g, (all, key) => key in values ? values[key] : all);
}

async function render(page, htmlFile, outDir, ffmpeg) {
  const framesDir = path.join(outDir, "frames");
  await mkdir(framesDir, { recursive: true });
  for (const f of await readdir(framesDir)) if (/^frame_\d+\.jpg$/.test(f)) await rm(path.join(framesDir, f));

  await page.goto(pathToFileURL(htmlFile).href + "?export");
  await page.evaluate(() => window.painter.ready);
  const meta = await page.evaluate(() => ({
    fps: window.painter.CONFIG.fps, scale: window.painter.CONFIG.scale,
    passes: window.painter.F.passes.map(p => ({ name: p.name, width: +p.width.toFixed(2), frames: p.frames })),
  }));
  const save = async (file, type, quality, scale) => {
    const url = await page.evaluate((t, q, s) => window.painter.frameDataURL(t, q, s), type, quality, scale);
    await writeFile(file, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
  };
  const frameFile = n => path.join(framesDir, "frame_" + String(n).padStart(4, "0") + ".jpg");
  const passEnds = [];                                    // 每一遍画完时的帧号
  meta.passes.reduce((sum, p) => { passEnds.push(sum + p.frames); return sum + p.frames; }, 0);

  const started = Date.now();
  await save(frameFile(0), "image/jpeg", 0.9, 1);          // 第 0 帧：空白画布
  let info;
  do {
    info = await page.evaluate(() => window.painter.stepFrame());
    await save(frameFile(info.frame), "image/jpeg", 0.9, 1);
    if (info.frame % 100 === 0) console.log(`  第 ${info.frame} / ${info.totalFrames} 帧 · ${info.strokes.toLocaleString()} 笔`);
  } while (!info.done);
  await save(path.join(outDir, "final.png"), "image/png", 1, meta.scale);
  await save(path.join(outDir, "final-1x.png"), "image/png", 1, 1);

  const files = [`frames/（${info.frame + 1} 张）`, "final.png", "final-1x.png"];
  if (ffmpeg) {
    const quiet = ["-y", "-loglevel", "error"];
    // H.264 要求宽高是偶数，奇数时裁掉一行/一列；最后一帧多停几秒
    await run(ffmpeg, [...quiet, "-framerate", String(meta.fps), "-i", path.join(framesDir, "frame_%04d.jpg"),
      "-vf", `crop=trunc(iw/2)*2:trunc(ih/2)*2,tpad=stop_mode=clone:stop_duration=${HOLD_SECONDS}`,
      "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      path.join(outDir, "painting-process.mp4")]);

    // 过程一览：空白画布、每一遍画完时、成品；格子多了就排成两行
    const picks = [0, ...passEnds, info.frame];
    const rows = picks.length >= 6 ? 2 : 1;
    if (picks.length % rows) picks.shift();
    const perRow = picks.length / rows, cells = picks.map((_, i) => `[s${i}]`);
    const row = k => cells.slice(k * perRow, (k + 1) * perRow).join("") + `hstack=${perRow}`;
    await run(ffmpeg, [...quiet, ...picks.flatMap(n => ["-i", frameFile(n)]), "-filter_complex",
      picks.map((_, i) => `[${i}]scale=500:-2${cells[i]}`).join(";") + ";"
        + (rows === 1 ? row(0) : `${row(0)}[a];${row(1)}[b];[a][b]vstack`),
      "-q:v", "2", path.join(outDir, "process-sheet.jpg")]);
    files.push("painting-process.mp4", "process-sheet.jpg");
  } else {
    console.warn("没有找到 ffmpeg，跳过视频和过程一览图。重新运行 npm install，或自行安装 ffmpeg 后再试。");
  }
  return { meta, stats: info.stats, passEnds, seconds: (Date.now() - started) / 1000, files };
}

async function main() {
  const opts = parseCli();
  const image = await loadImage(opts.image);
  const { config, file: configFile } = await loadConfig(opts);
  const name = path.basename(opts.image).replace(/\.[^.]+$/, "");
  const outDir = path.resolve(opts.out || path.join(root, "output", name));
  const chrome = findChrome(opts.chrome);
  const ffmpeg = opts["html-only"] ? null : await findFfmpeg();
  const template = await readFile(path.join(root, "src/painting.template.html"), "utf8");
  const escapeHtml = s => s.replace(/[&<>"]/g, ch => "&#" + ch.charCodeAt(0) + ";");

  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--allow-file-access-from-files"] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", e => pageErrors.push(e));
    page.on("console", m => { if (m.text().startsWith("[画笔]")) console.log("  " + m.text().slice(5)); });

    const ref = await prepareReference(page, image, opts.size);
    const resized = ref.width !== ref.original[0] ? `（原图 ${ref.original.join("×")}）` : "";
    console.log(`参考图：${path.basename(opts.image)}，作画尺寸 ${ref.width}×${ref.height}${resized}`);
    console.log(configFile ? "设置：" + path.relative(process.cwd(), configFile) : "设置：全自动（没有 .paint.json）");

    await mkdir(outDir, { recursive: true });
    const htmlFile = path.join(outDir, "painting.html");
    await writeFile(htmlFile, buildHtml(template, {
      TITLE: escapeHtml(name), REFERENCE_DATA_URI: ref.url, USER_CONFIG: JSON.stringify(config).replace(/</g, "\\u003c"),
    }));
    const shown = path.relative(process.cwd(), outDir) || ".";
    if (opts["html-only"]) { console.log(`已生成 ${path.join(shown, "painting.html")}，双击即可观看作画过程`); return; }

    const r = await render(page, htmlFile, outDir, ffmpeg);
    if (pageErrors.length) throw pageErrors[0];
    await writeFile(path.join(outDir, "stats.json"), JSON.stringify({
      source: path.basename(opts.image), width: ref.width, height: ref.height, original: ref.original,
      ...r.meta, ...r.stats, passEndFrames: r.passEnds, renderSeconds: +r.seconds.toFixed(1), config,
    }, null, 2));
    console.log(`画完：${r.stats.strokes.toLocaleString()} 笔，${r.stats.frames} 帧，用时 ${r.seconds.toFixed(1)} 秒`);
    console.log(`与参考图相比：平均绝对误差 ${r.stats.final.mae.toFixed(2)}%，PSNR ${r.stats.final.psnr.toFixed(1)} dB`);
    console.log(`输出在 ${shown}/：painting.html、${r.files.join("、")}、stats.json`);
  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error(e instanceof UserError ? e.message : e);
  process.exit(1);
});
