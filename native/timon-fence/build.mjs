#!/usr/bin/env node
// Builds timon-fence, the Linux mission launcher (timon-fence.c), as a static
// executable with no runtime dependency.
//
//   node native/timon-fence/build.mjs [--arch host|x64|arm64|all] [--out FILE] [--optional]
//
// Output: native/timon-fence/build/linux-<arch>/timon-fence, where the daemon
// of a source checkout looks for it (orchestrator/src/host/fence.ts), or FILE
// with --out (a single architecture). The desktop package builds the host
// architecture while it prepares the daemon release: packages are built on
// their target machine, never cross-built.
//
// Compiler, first found: $TIMON_FENCE_CC (one architecture), a musl compiler
// for the target (smallest binary), then the target's gcc with a static glibc
// (needs libc.a: the libc6-dev package). --optional reports a missing
// compiler and exits 0, for a source install where the fence is a bonus;
// there, a launcher that fails the baseline check below is only reported,
// since it runs on the machine that built it.
//
// x64 targets the x86-64 baseline (`-march=x86-64`): a package runs on CPUs
// the build machine does not have, and a launcher that needs AVX2 dies with
// SIGILL on an older one, leaving every mission unfenced. The build refuses a
// binary that would (`assertBaselineX64`).
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { arch as hostArch, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FENCE_SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
export const FENCE_ARCHES = ['x64', 'arm64'];

/** Where a source checkout keeps the binary of one architecture. */
export function fenceBuildOutput(arch, dir = FENCE_SOURCE_DIR) {
  return join(dir, 'build', `linux-${arch}`, 'timon-fence');
}

const TRIPLE = { x64: 'x86_64', arm64: 'aarch64' };

/** Compilers to try for `arch`, best first; the bare names only target the host. */
export function compilerCandidates(arch, host = hostArch(), env = process.env) {
  if (env.TIMON_FENCE_CC) return [env.TIMON_FENCE_CC];
  const triple = TRIPLE[arch];
  const native = arch === host;
  return [
    `${triple}-linux-musl-gcc`,
    ...(native ? ['musl-gcc'] : []),
    ...(native ? ['cc', 'gcc'] : []),
    `${triple}-linux-gnu-gcc`,
  ];
}

export const CFLAGS = [
  '-std=c11', '-O2', '-Wall', '-Wextra', '-Wpedantic', '-Werror',
  '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2', '-static', '-s',
];

/** Instruction set per architecture: the oldest CPU the package supports, never the build machine's. */
export const ARCH_CFLAGS = {
  x64: ['-march=x86-64', '-mtune=generic'],
  arm64: [],
};

/** Every flag for `arch`, stripped (`-s`) or not: the guard reads the symbols. */
export function fenceCflags(arch, { strip = true } = {}) {
  return [...CFLAGS.filter((flag) => strip || flag !== '-s'), ...(ARCH_CFLAGS[arch] ?? [])];
}

/*
 * Mnemonics (AT&T, as objdump prints them) an x86-64 baseline CPU does not
 * have: SSE3, SSSE3, SSE4.1/4.2, POPCNT, LZCNT, BMI1/2, MOVBE, ADX, AES,
 * PCLMUL, SHA, RDRAND, CMPXCHG16B, LAHF in long mode. VEX and EVEX encodings
 * (AVX, AVX2, FMA, F16C, AVX-512) are caught by their `v` prefix and their
 * registers. `tzcnt` is left out on purpose: it is what objdump prints for
 * `rep bsf`, which compilers emit for any CPU (a baseline one runs it as bsf).
 */
const POST_BASELINE_MNEMONICS = new Set([
  'addsubpd', 'addsubps', 'haddpd', 'haddps', 'hsubpd', 'hsubps', 'lddqu', 'movddup', 'movshdup', 'movsldup',
  'pabsb', 'pabsw', 'pabsd', 'palignr', 'phaddw', 'phaddd', 'phaddsw', 'phsubw', 'phsubd', 'phsubsw',
  'pmaddubsw', 'pmulhrsw', 'pshufb', 'psignb', 'psignw', 'psignd',
  'blendpd', 'blendps', 'blendvpd', 'blendvps', 'dppd', 'dpps', 'extractps', 'insertps', 'movntdqa', 'mpsadbw',
  'packusdw', 'pblendvb', 'pblendw', 'pcmpeqq', 'pextrb', 'pextrd', 'pextrq', 'phminposuw', 'pinsrb', 'pinsrd',
  'pinsrq', 'pmaxsb', 'pmaxsd', 'pmaxud', 'pmaxuw', 'pminsb', 'pminsd', 'pminud', 'pminuw', 'pmuldq', 'pmulld',
  'ptest', 'roundpd', 'roundps', 'roundsd', 'roundss',
  'pcmpestri', 'pcmpestrm', 'pcmpistri', 'pcmpistrm', 'pcmpgtq',
  'popcnt', 'lzcnt', 'andn', 'bextr', 'blsi', 'blsmsk', 'blsr', 'bzhi', 'mulx', 'pdep', 'pext',
  'rorx', 'sarx', 'shlx', 'shrx', 'movbe', 'adcx', 'adox',
  'aesenc', 'aesenclast', 'aesdec', 'aesdeclast', 'aesimc', 'aeskeygenassist', 'pclmulqdq',
  'sha1rnds4', 'sha1nexte', 'sha1msg1', 'sha1msg2', 'sha256rnds2', 'sha256msg1', 'sha256msg2',
  'rdrand', 'rdseed', 'cmpxchg16b', 'lahf', 'sahf',
]);

/** Baseline instructions that happen to start with `v`. */
const BASELINE_V_MNEMONICS = new Set(['verr', 'verw']);

/**
 * A C library ships one copy of a string routine per CPU level and picks the
 * one this CPU runs at startup (glibc's IFUNC): those copies carry the level
 * in their name, and only they may hold post-baseline instructions.
 */
const CPU_VARIANT_NAME = /(?:^|_)(?:avx\d*|avx512\w*|evex\d*|sse[234](?:_\d)?|ssse3|sse42|bmi2?|movbe|rtm|erms|fma4?|x86_64_v[234]|xsavec?|lzcnt|popcnt|aesni|pclmul|sha_?ni)(?:_|$)/i;

/** The base mnemonic of an objdump instruction text, without prefixes nor the AT&T size suffix. */
function mnemonicOf(text) {
  const words = text.trim().split(/\s+/);
  while (words.length > 1 && /^(?:rep[nz]?e?|lock|notrack|bnd|data16|addr32|cs|ds|es|ss|fs|gs|rex(?:\.\w+)?)$/.test(words[0])) words.shift();
  return words[0] ?? '';
}

function postBaseline(text) {
  if (/%[yz]mm\d|%k[0-7]\b/.test(text)) return true;
  const mnemonic = mnemonicOf(text);
  if (mnemonic.startsWith('v') && !BASELINE_V_MNEMONICS.has(mnemonic)) return true;
  if (POST_BASELINE_MNEMONICS.has(mnemonic)) return true;
  // AT&T adds a size suffix to some of them (popcntq, crc32b, andnl…).
  if (/^crc32[bwlq]?$/.test(mnemonic)) return true;
  const unsized = mnemonic.replace(/[bwlq]$/, '');
  return unsized !== mnemonic && POST_BASELINE_MNEMONICS.has(unsized);
}

/**
 * The functions of an `objdump -d` listing that use an instruction an x86-64
 * baseline CPU lacks, outside the per-CPU copies a C library selects at run
 * time. Each entry names the function and its first such instruction.
 */
export function postBaselineFunctions(disassembly) {
  const found = new Map();
  let fn = '?';
  for (const line of disassembly.split('\n')) {
    const header = /^[0-9a-f]+ <(.+)>:$/.exec(line);
    if (header) { fn = header[1]; continue; }
    const insn = /^\s*[0-9a-f]+:\t(?:[0-9a-f]{2} )*\s*\t?(.+)$/.exec(line);
    if (!insn || found.has(fn) || CPU_VARIANT_NAME.test(fn)) continue;
    if (postBaseline(insn[1])) found.set(fn, insn[1].trim().replace(/\s+/g, ' '));
  }
  return [...found].map(([name, instruction]) => `${name}: ${instruction}`);
}

const OBJDUMP = { x64: ['objdump', 'x86_64-linux-gnu-objdump', 'x86_64-linux-musl-objdump'] };

/**
 * Refuses an x64 launcher a baseline CPU cannot run. Reads the disassembly of
 * an unstripped build: the symbols tell the C library's per-CPU copies apart
 * from code every CPU runs. No disassembler is an error: a release must not
 * ship a launcher nobody checked.
 */
export function assertBaselineX64(binary, { disassemble = defaultDisassemble } = {}) {
  const listing = disassemble(binary);
  if (!/^[0-9a-f]+ <.+>:$/m.test(listing)) throw new Error(`[timon-fence] cannot check ${binary}: the disassembly lists no function`);
  const offending = postBaselineFunctions(listing);
  if (offending.length === 0) return;
  const shown = offending.slice(0, 8).join('; ');
  throw new Error(`[timon-fence] the x64 launcher needs instructions an x86-64 baseline CPU lacks (${shown}${offending.length > 8 ? '; …' : ''}): `
    + 'it would die with SIGILL on older CPUs. Build it with a compiler and a C library that target x86-64 (musl-tools, or a distribution whose libc is not built for x86-64-v2 or later).');
}

function defaultDisassemble(binary) {
  for (const tool of OBJDUMP.x64) {
    try {
      return execFileSync(tool, ['-d', '--no-show-raw-insn', binary], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`[timon-fence] ${tool} cannot read ${binary}: ${error instanceof Error ? error.message : error}`);
    }
  }
  throw new Error(`[timon-fence] no disassembler to check the x64 launcher (tried ${OBJDUMP.x64.join(', ')}): install binutils`);
}

function available(compiler) {
  try {
    execFileSync(compiler, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Compiles one architecture; returns the compiler used, or null when none is found. */
export function buildFence(arch, out = fenceBuildOutput(arch), { host = hostArch(), env = process.env, log = console.log, checkBaseline = assertBaselineX64 } = {}) {
  if (!FENCE_ARCHES.includes(arch)) throw new Error(`Unsupported architecture: ${arch} (expected ${FENCE_ARCHES.join(' or ')})`);
  const compiler = compilerCandidates(arch, host, env).find(available);
  if (!compiler) return null;
  const source = join(FENCE_SOURCE_DIR, 'timon-fence.c');
  if (arch === 'x64') {
    // Built twice: the symbols the check needs are stripped from the shipped copy.
    const scratch = mkdtempSync(join(tmpdir(), 'timon-fence-check-'));
    try {
      const unstripped = join(scratch, 'timon-fence');
      execFileSync(compiler, [...fenceCflags(arch, { strip: false }), '-o', unstripped, source], { stdio: 'inherit' });
      checkBaseline(unstripped);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  execFileSync(compiler, [...fenceCflags(arch), '-o', out, source], { stdio: 'inherit' });
  chmodSync(out, 0o755);
  // A binary for this machine must run here; another architecture is only
  // checked for presence (packages are built on their own machine anyway).
  if (arch === host) execFileSync(out, ['--version'], { stdio: 'ignore' });
  log(`[timon-fence] linux-${arch}: ${out} (${compiler}, ${statSync(out).size} bytes)`);
  return compiler;
}

function parseArgs(argv) {
  const opts = { arch: 'host', out: null, optional: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--optional') opts.optional = true;
    else if (flag === '--arch' && argv[i + 1]) opts.arch = argv[++i];
    else if (flag === '--out' && argv[i + 1]) opts.out = resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (platform() !== 'linux') {
    if (opts.optional) { console.log('[timon-fence] not built: Linux only'); return; }
    throw new Error('timon-fence is a Linux launcher: build it on Linux');
  }
  const arches = opts.arch === 'all' ? FENCE_ARCHES : [opts.arch === 'host' ? hostArch() : opts.arch];
  if (opts.out && arches.length > 1) throw new Error('--out names one file: choose one --arch');
  for (const arch of arches) {
    // A source install builds for this machine only, and the smoke run proves
    // it runs here: a refused baseline is reported, not fatal. A package
    // (`desktop/scripts/prepare-daemon-release.mjs`) always refuses it.
    const checkBaseline = opts.optional
      ? (binary) => {
        try { assertBaselineX64(binary); } catch (error) {
          console.warn(`${error instanceof Error ? error.message : error} Kept for this machine only.`);
        }
      }
      : assertBaselineX64;
    const used = buildFence(arch, opts.out ?? fenceBuildOutput(arch), { checkBaseline });
    if (used) continue;
    const message = `[timon-fence] no C compiler for linux-${arch} (tried ${compilerCandidates(arch).join(', ')})`;
    if (opts.optional || opts.arch === 'all') console.warn(`${message}: skipped`);
    else throw new Error(`${message}. Install gcc and libc6-dev, or musl-tools.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
