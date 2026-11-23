import type { AnnotationDto, ImageAdjustments } from "../lib/api";

const VERT_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
	v_uv = a_pos * 0.5 + 0.5;
	gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform vec2 u_size;
uniform float u_exposure;
uniform float u_contrast;
uniform float u_highlights;
uniform float u_shadows;
uniform float u_temperature;
uniform float u_tint;
uniform float u_vibrance;
uniform float u_saturation;
uniform float u_clarity;
uniform float u_vignette;
uniform float u_fade;
uniform float u_grain;
uniform float u_sepia;
uniform float u_bloom;
uniform float u_splitShadowHue;
uniform float u_splitShadowAmt;
uniform float u_splitHighlightHue;
uniform float u_splitHighlightAmt;

float luma(vec3 c) {
	return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 hueToRgb(float deg) {
	float h = mod(deg, 360.0) / 60.0;
	float x = 1.0 - abs(mod(h, 2.0) - 1.0);
	vec3 rgb =
		h < 1.0 ? vec3(1.0, x, 0.0) :
		h < 2.0 ? vec3(x, 1.0, 0.0) :
		h < 3.0 ? vec3(0.0, 1.0, x) :
		h < 4.0 ? vec3(0.0, x, 1.0) :
		h < 5.0 ? vec3(x, 0.0, 1.0) :
		vec3(1.0, 0.0, x);
	return rgb;
}

float hash12(vec2 p) {
	vec3 p3 = fract(vec3(p.xyx) * 0.1031);
	p3 += dot(p3, p3.yzx + 33.33);
	return fract((p3.x + p3.y) * p3.z);
}

vec3 applyGrades(vec3 c) {
	// Exposure (stops)
	c *= exp2(u_exposure);

	// Temperature (amber <-> blue) & Tint (magenta <-> green)
	c.r += u_temperature * 0.14 + u_tint * 0.06;
	c.g -= u_tint * 0.10;
	c.b -= u_temperature * 0.14 - u_tint * 0.06;
	c = clamp(c, 0.0, 1.0);

	// Highlights & Shadows tone curve
	float y = luma(c);
	float hiMask = smoothstep(0.45, 1.0, y);
	float loMask = 1.0 - smoothstep(0.0, 0.55, y);
	c += vec3(u_highlights * 0.28 * hiMask + u_shadows * 0.28 * loMask);
	c = clamp(c, 0.0, 1.0);

	// Contrast S-curve
	float cf = 1.0 + u_contrast * 0.75;
	c = (c - 0.5) * cf + 0.5;
	c = clamp(c, 0.0, 1.0);

	// Matte / lifted blacks film curve
	if (u_fade > 0.005) {
		float lift = u_fade * 0.16;
		c = c * (1.0 - lift * 0.75) + vec3(lift);
		c = clamp(c, 0.0, 1.0);
	}

	// Vibrance (protects already-saturated colors) & Saturation
	float mx = max(c.r, max(c.g, c.b));
	float mn = min(c.r, min(c.g, c.b));
	float curSat = mx - mn;
	float vibWeight = (1.0 - curSat) * u_vibrance;
	float y2 = luma(c);
	c = mix(vec3(y2), c, max(0.0, 1.0 + vibWeight + u_saturation));
	c = clamp(c, 0.0, 1.0);

	// Archival warm sepia toning
	if (u_sepia > 0.005) {
		vec3 sep = vec3(
			dot(c, vec3(0.393, 0.769, 0.189)),
			dot(c, vec3(0.349, 0.686, 0.168)),
			dot(c, vec3(0.272, 0.534, 0.131))
		);
		c = mix(c, clamp(sep, 0.0, 1.0), u_sepia);
	}

	// Split toning (independent shadow & highlight color tints)
	if (u_splitShadowAmt > 0.005 || u_splitHighlightAmt > 0.005) {
		float yt = luma(c);
		if (u_splitShadowAmt > 0.005) {
			float sm = (1.0 - smoothstep(0.08, 0.62, yt)) * u_splitShadowAmt * 0.35;
			vec3 sc = hueToRgb(u_splitShadowHue);
			c = mix(c, clamp(c + (sc - 0.5) * 0.55, 0.0, 1.0), sm);
		}
		if (u_splitHighlightAmt > 0.005) {
			float hm = smoothstep(0.38, 0.92, yt) * u_splitHighlightAmt * 0.35;
			vec3 hc = hueToRgb(u_splitHighlightHue);
			c = mix(c, clamp(c + (hc - 0.5) * 0.55, 0.0, 1.0), hm);
		}
	}

	return clamp(c, 0.0, 1.0);
}

void main() {
	vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
	vec4 tex = texture(u_tex, uv);
	vec3 rgb = tex.rgb;

	// Local micro-contrast (clarity) via 4-tap unsharp mask
	if (abs(u_clarity) > 0.005) {
		vec3 blur = (
			texture(u_tex, uv + vec2(u_texel.x * 2.0, 0.0)).rgb +
			texture(u_tex, uv - vec2(u_texel.x * 2.0, 0.0)).rgb +
			texture(u_tex, uv + vec2(0.0, u_texel.y * 2.0)).rgb +
			texture(u_tex, uv - vec2(0.0, u_texel.y * 2.0)).rgb
		) * 0.25;
		rgb = clamp(rgb + (rgb - blur) * (u_clarity * 0.9), 0.0, 1.0);
	}

	// Pro-Mist / halation soft glow on bright highlights (8-tap radial blur)
	if (u_bloom > 0.005) {
		vec3 glow = vec3(0.0);
		vec2 r1 = u_texel * 3.5;
		vec2 r2 = u_texel * 7.0;
		vec3 s0 = texture(u_tex, uv + vec2(r1.x, 0.0)).rgb;
		vec3 s1 = texture(u_tex, uv - vec2(r1.x, 0.0)).rgb;
		vec3 s2 = texture(u_tex, uv + vec2(0.0, r1.y)).rgb;
		vec3 s3 = texture(u_tex, uv - vec2(0.0, r1.y)).rgb;
		vec3 s4 = texture(u_tex, uv + vec2(r2.x, r2.y) * 0.707).rgb;
		vec3 s5 = texture(u_tex, uv + vec2(-r2.x, r2.y) * 0.707).rgb;
		vec3 s6 = texture(u_tex, uv + vec2(r2.x, -r2.y) * 0.707).rgb;
		vec3 s7 = texture(u_tex, uv + vec2(-r2.x, -r2.y) * 0.707).rgb;
		glow += max(s0 - 0.55, 0.0) + max(s1 - 0.55, 0.0) + max(s2 - 0.55, 0.0) + max(s3 - 0.55, 0.0);
		glow += (max(s4 - 0.55, 0.0) + max(s5 - 0.55, 0.0) + max(s6 - 0.55, 0.0) + max(s7 - 0.55, 0.0)) * 0.75;
		glow /= 7.0;
		rgb = clamp(rgb + glow * (u_bloom * 0.85), 0.0, 1.0);
	}

	rgb = applyGrades(rgb);

	// Deterministic luminance-weighted organic film grain
	if (u_grain > 0.005) {
		float gNoise = hash12(floor(v_uv * u_size)) - 0.5;
		float yg = luma(rgb);
		float midWeight = 1.0 - abs(yg - 0.5) * 1.1;
		rgb = clamp(rgb + vec3(gNoise * u_grain * 0.24 * max(0.35, midWeight)), 0.0, 1.0);
	}

	if (u_vignette > 0.005) {
		float d = distance(uv, vec2(0.5)) * 1.4142;
		float vig = 1.0 - smoothstep(0.45, 1.15, d) * (u_vignette * 0.65);
		rgb *= vig;
	}

	outColor = vec4(rgb, tex.a);
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
	const shader = gl.createShader(type);
	if (!shader) throw new Error("Failed to create shader");
	gl.shaderSource(shader, src);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		const info = gl.getShaderInfoLog(shader);
		gl.deleteShader(shader);
		throw new Error(`Shader compile error: ${info}`);
	}
	return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
	const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
	const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
	const prog = gl.createProgram();
	if (!prog) throw new Error("Failed to create WebGL program");
	gl.attachShader(prog, vs);
	gl.attachShader(prog, fs);
	gl.linkProgram(prog);
	gl.deleteShader(vs);
	gl.deleteShader(fs);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
		const info = gl.getProgramInfoLog(prog);
		gl.deleteProgram(prog);
		throw new Error(`Program link error: ${info}`);
	}
	return prog;
}

export function hasNonZeroAdjustments(adj: ImageAdjustments | null | undefined): boolean {
	if (!adj) return false;
	return Boolean(
		adj.exposure ||
			adj.contrast ||
			adj.highlights ||
			adj.shadows ||
			adj.temperature ||
			adj.tint ||
			adj.vibrance ||
			adj.saturation ||
			adj.clarity ||
			adj.vignette ||
			adj.fade ||
			adj.grain ||
			adj.sepia ||
			adj.bloom ||
			adj.splitShadowAmt ||
			adj.splitHighlightAmt ||
			adj.straighten ||
			adj.rotate90 ||
			adj.flipH ||
			adj.flipV ||
			adj.crop,
	);
}

/**
 * WebGL2 real-time adjustment shader renderer. Falls back gracefully to a 2D
 * canvas filter when WebGL2 is unavailable (headless test / older browsers).
 */
export class GlImageRenderer {
	private gl: WebGL2RenderingContext | null = null;
	private prog: WebGLProgram | null = null;
	private tex: WebGLTexture | null = null;
	private vao: WebGLVertexArrayObject | null = null;
	private vbo: WebGLBuffer | null = null;
	private source: HTMLImageElement | HTMLCanvasElement | null = null;
	private texW = 1;
	private texH = 1;

	constructor(private readonly canvas: HTMLCanvasElement) {
		this.initGl();
	}

	private initGl(): void {
		try {
			const gl = this.canvas.getContext("webgl2", {
				alpha: true,
				premultipliedAlpha: false,
				preserveDrawingBuffer: true,
			});
			if (!gl) return;
			const prog = createProgram(gl);
			const vao = gl.createVertexArray();
			const vbo = gl.createBuffer();
			gl.bindVertexArray(vao);
			gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
			gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
			const loc = gl.getAttribLocation(prog, "a_pos");
			gl.enableVertexAttribArray(loc);
			gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
			gl.bindVertexArray(null);
			this.gl = gl;
			this.prog = prog;
			this.vao = vao;
			this.vbo = vbo;
		} catch {
			this.gl = null;
		}
	}

	setSource(img: HTMLImageElement | HTMLCanvasElement): void {
		this.source = img;
		const w = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
		const h = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
		if (w <= 0 || h <= 0) return;
		this.texW = w;
		this.texH = h;
		const gl = this.gl;
		if (!gl) return;
		if (!this.tex) this.tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, this.tex);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
	}

	render(adj: ImageAdjustments, width?: number, height?: number): void {
		if (!this.source) return;
		const w = Math.max(1, Math.round(width ?? this.texW));
		const h = Math.max(1, Math.round(height ?? this.texH));
		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w;
			this.canvas.height = h;
		}

		const gl = this.gl;
		if (gl && this.prog && this.tex && this.vao) {
			gl.viewport(0, 0, w, h);
			gl.clearColor(0, 0, 0, 0);
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.useProgram(this.prog);
			gl.bindVertexArray(this.vao);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, this.tex);
			gl.uniform1i(gl.getUniformLocation(this.prog, "u_tex"), 0);
			gl.uniform2f(gl.getUniformLocation(this.prog, "u_texel"), 1 / this.texW, 1 / this.texH);
			gl.uniform2f(gl.getUniformLocation(this.prog, "u_size"), w, h);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_exposure"), adj.exposure ?? 0);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_contrast"), adj.contrast ?? 0);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_highlights"), adj.highlights ?? 0);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_shadows"), adj.shadows ?? 0);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_temperature"), adj.temperature ?? 0);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_tint"), adj.tint ?? 0);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_vibrance"), adj.vibrance ?? 0);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_saturation"), adj.saturation ?? 0);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_clarity"), adj.clarity ?? 0);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_vignette"), adj.vignette ?? 0);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_fade"), adj.fade ?? 0);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_grain"), adj.grain ?? 0);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_sepia"), adj.sepia ?? 0);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_bloom"), adj.bloom ?? 0);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_splitShadowHue"), adj.splitShadowHue ?? 0);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_splitShadowAmt"), adj.splitShadowAmt ?? 0);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_splitHighlightHue"), adj.splitHighlightHue ?? 0);
			gl.uniform1f(gl.getUniformLocation(this.prog, "u_splitHighlightAmt"), adj.splitHighlightAmt ?? 0);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
			gl.bindVertexArray(null);
			return;
		}

		// Graceful 2D fallback when WebGL2 is absent.
		const ctx = this.canvas.getContext("2d");
		if (!ctx) return;
		ctx.clearRect(0, 0, w, h);
		const b = 1 + (adj.exposure ?? 0) * 0.35;
		const c = 1 + (adj.contrast ?? 0) * 0.6;
		const s = Math.max(0, 1 + (adj.saturation ?? 0) * 0.8 + (adj.vibrance ?? 0) * 0.4);
		const sep = Math.min(1, (adj.sepia ?? 0) + Math.max(0, (adj.temperature ?? 0) * 0.25));
		ctx.filter = `brightness(${b}) contrast(${c}) saturate(${s}) sepia(${sep})`;
		ctx.drawImage(this.source, 0, 0, w, h);
		ctx.filter = "none";
	}

	dispose(): void {
		const gl = this.gl;
		if (!gl) return;
		if (this.tex) gl.deleteTexture(this.tex);
		if (this.vbo) gl.deleteBuffer(this.vbo);
		if (this.vao) gl.deleteVertexArray(this.vao);
		if (this.prog) gl.deleteProgram(this.prog);
		this.tex = null;
		this.vbo = null;
		this.vao = null;
		this.prog = null;
		this.source = null;
	}
}

export async function loadImageElement(src: string): Promise<HTMLImageElement> {
	const img = new Image();
	img.crossOrigin = "anonymous";
	img.src = src;
	await new Promise<void>((resolve, reject) => {
		img.onload = () => resolve();
		img.onerror = () => reject(new Error("Could not load image"));
	});
	return img;
}

/** Bake non-destructive color adjustments + geometry transforms + annotations into a Blob. */
export async function bakeAdjustedBlob(
	sourceUrl: string,
	adj: ImageAdjustments,
	annotations: AnnotationDto[] = [],
	outputMime: "image/png" | "image/jpeg" = "image/png",
): Promise<Blob> {
	const img = await loadImageElement(sourceUrl);
	const scale = Math.min(1, Math.sqrt(24_000_000 / Math.max(1, img.naturalWidth * img.naturalHeight)));
	const srcW = Math.max(1, Math.round(img.naturalWidth * scale));
	const srcH = Math.max(1, Math.round(img.naturalHeight * scale));

	// Step 1: apply WebGL2 color grading on a temporary canvas.
	const graded = document.createElement("canvas");
	const renderer = new GlImageRenderer(graded);
	renderer.setSource(img);
	renderer.render(adj, srcW, srcH);
	renderer.dispose();

	// Step 2: apply rotate90 / flip / straighten / crop + draw annotations onto final canvas.
	const rot = ((adj.rotate90 ?? 0) % 4 + 4) % 4;
	const rotatedSwap = rot % 2 === 1;
	const baseW = rotatedSwap ? srcH : srcW;
	const baseH = rotatedSwap ? srcW : srcH;

	const crop = adj.crop ?? { x: 0, y: 0, w: 1, h: 1 };
	const outW = Math.max(1, Math.round(crop.w * baseW));
	const outH = Math.max(1, Math.round(crop.h * baseH));

	const out = document.createElement("canvas");
	out.width = outW;
	out.height = outH;
	const ctx = out.getContext("2d");
	if (!ctx) throw new Error("Canvas unavailable");

	ctx.save();
	ctx.translate(-crop.x * baseW, -crop.y * baseH);
	ctx.translate(baseW / 2, baseH / 2);
	ctx.rotate((rot * Math.PI) / 2 + ((adj.straighten ?? 0) * Math.PI) / 180);
	ctx.scale(adj.flipH ? -1 : 1, adj.flipV ? -1 : 1);
	if (adj.straighten && Math.abs(adj.straighten) > 0.05) {
		const rad = Math.abs((adj.straighten * Math.PI) / 180);
		const zoomToCover = Math.cos(rad) + Math.sin(rad) * Math.max(srcW / srcH, srcH / srcW);
		ctx.scale(zoomToCover, zoomToCover);
	}
	ctx.drawImage(graded, -srcW / 2, -srcH / 2, srcW, srcH);
	ctx.restore();

	drawAnnotations(ctx, outW, outH, annotations);

	return new Promise<Blob>((resolve, reject) => {
		out.toBlob(
			(b) => (b ? resolve(b) : reject(new Error("Export failed"))),
			outputMime,
			outputMime === "image/jpeg" ? 0.92 : undefined,
		);
	});
}

export function drawAnnotations(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	annotations: AnnotationDto[],
): void {
	if (!annotations.length) return;
	ctx.save();
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	const refSide = Math.min(width, height);
	for (const a of annotations) {
		const px = Math.max(12, Math.round(a.fontSize * refSide));
		ctx.font = `600 ${px}px Inter, system-ui, sans-serif`;
		const x = a.normX * width;
		const y = a.normY * height;
		ctx.lineJoin = "round";
		ctx.lineWidth = Math.max(2, px * 0.14);
		ctx.strokeStyle = "rgba(0,0,0,0.65)";
		ctx.strokeText(a.text, x, y);
		ctx.fillStyle = a.color || "#ffffff";
		ctx.fillText(a.text, x, y);
	}
	ctx.restore();
}

export async function renderOverlayPngBlob(
	width: number,
	height: number,
	annotations: AnnotationDto[],
): Promise<Blob | null> {
	if (!annotations.length) return null;
	const canvas = document.createElement("canvas");
	canvas.width = Math.min(2048, Math.max(1, width));
	canvas.height = Math.min(2048, Math.max(1, height));
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	drawAnnotations(ctx, canvas.width, canvas.height, annotations);
	return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
}

/** Extract dominant distinct hex colors from a loaded image via spatial sampling. */
export function extractImageColors(img: HTMLImageElement | HTMLCanvasElement, count = 5): string[] {
	const canvas = document.createElement("canvas");
	canvas.width = 48;
	canvas.height = 48;
	const ctx = canvas.getContext("2d");
	if (!ctx) return [];
	ctx.drawImage(img, 0, 0, 48, 48);
	const data = ctx.getImageData(0, 0, 48, 48).data;
	const buckets = new Map<string, { r: number; g: number; b: number; n: number }>();
	for (let i = 0; i < data.length; i += 4) {
		if ((data[i + 3] ?? 255) < 128) continue;
		const r = data[i]!;
		const g = data[i + 1]!;
		const b = data[i + 2]!;
		const key = `${r >> 5},${g >> 5},${b >> 5}`;
		const cur = buckets.get(key);
		if (cur) {
			cur.r += r;
			cur.g += g;
			cur.b += b;
			cur.n += 1;
		} else {
			buckets.set(key, { r, g, b, n: 1 });
		}
	}
	const sorted = [...buckets.values()].sort((a, b) => b.n - a.n);
	const picked: Array<{ r: number; g: number; b: number }> = [];
	for (const c of sorted) {
		const r = Math.round(c.r / c.n);
		const g = Math.round(c.g / c.n);
		const b = Math.round(c.b / c.n);
		const tooClose = picked.some((p) => Math.hypot(p.r - r, p.g - g, p.b - b) < 42);
		if (!tooClose) picked.push({ r, g, b });
		if (picked.length >= count) break;
	}
	const hex = (n: number) => n.toString(16).padStart(2, "0");
	return picked.map((p) => `#${hex(p.r)}${hex(p.g)}${hex(p.b)}`);
}

/**
 * Render live WebGL2 filter thumbnail previews on the user's actual photo using
 * ONE shared offscreen canvas/context so GPU memory stays minimal and fast.
 */
export function renderPresetThumbnails(
	source: HTMLImageElement | HTMLCanvasElement,
	presets: Array<{ id: string; adjustments?: ImageAdjustments }>,
	maxSide = 160,
): Record<string, string> {
	const natW = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
	const natH = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
	if (natW <= 0 || natH <= 0 || presets.length === 0) return {};

	const scale = Math.min(1, maxSide / Math.max(natW, natH));
	const w = Math.max(24, Math.round(natW * scale));
	const h = Math.max(24, Math.round(natH * scale));

	// Downscale once so texture upload is tiny (~160px).
	const small = document.createElement("canvas");
	small.width = w;
	small.height = h;
	const sctx = small.getContext("2d");
	if (!sctx) return {};
	sctx.drawImage(source, 0, 0, w, h);

	const out: Record<string, string> = {};
	const canvas = document.createElement("canvas");
	const renderer = new GlImageRenderer(canvas);
	try {
		renderer.setSource(small);
		for (const item of presets) {
			if (!item.adjustments) continue;
			renderer.render(item.adjustments, w, h);
			try {
				out[item.id] = canvas.toDataURL("image/jpeg", 0.78);
			} catch {
				// Ignore tainted canvas errors in headless environments.
			}
		}
	} finally {
		renderer.dispose();
	}
	return out;
}
