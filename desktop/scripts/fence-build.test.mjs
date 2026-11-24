import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertBaselineX64, buildFence, compilerCandidates, fenceCflags, postBaselineFunctions } from '../../native/timon-fence/build.mjs';

// The launcher ships to CPUs the build machine is not: a package built where
// AVX2 is the default died with SIGILL on an older CPU and every mission ran
// unfenced. These tests pin the baseline flags and the guard that reads them.

const listing = (...functions) => functions
  .map(([name, ...insns]) => [`0000000000401000 <${name}>:`, ...insns.map((insn, i) => `  ${(0x401000 + i * 4).toString(16)}:\t${insn}`)].join('\n'))
  .join('\n\n');

test('x64 targets the x86-64 baseline; arm64 keeps the compiler default', () => {
  const x64 = fenceCflags('x64');
  assert.ok(x64.includes('-march=x86-64'));
  assert.ok(x64.includes('-mtune=generic'));
  assert.ok(x64.includes('-s'));
  assert.equal(fenceCflags('x64', { strip: false }).includes('-s'), false);
  assert.equal(fenceCflags('arm64').some((flag) => flag.startsWith('-march')), false);
});

test('a baseline listing passes, rep bsf and the per-CPU copies of the C library included', () => {
  const disassembly = listing(
    ['main', 'endbr64', 'push   %r15', 'mov    %rsp,%rbp', 'tzcnt  %eax,%eax', 'rep stos %rax,%es:(%rdi)', 'pxor   %xmm0,%xmm0', 'cpuid', 'xgetbv'],
    ['__memcpy_avx_unaligned_erms', 'vmovdqu (%rsi),%ymm0'],
    ['__memcmp_avx2_movbe_rtm', 'movbe  (%rdi),%eax'],
    ['__strstr_avx512', 'vpcmpeqb %zmm1,%zmm0,%k1'],
    ['__strchr_sse2', 'pcmpeqb %xmm1,%xmm0'],
  );
  assert.deepEqual(postBaselineFunctions(disassembly), []);
  assert.doesNotThrow(() => assertBaselineX64('/fence', { disassemble: () => disassembly }));
});

test('post-baseline instructions outside the per-CPU copies are named, one per function', () => {
  const disassembly = listing(
    ['main', 'push   %rbp', 'vpxor  %xmm1,%xmm1,%xmm1', 'vmovdqu %ymm0,(%rdi)'],
    ['apply_policy', 'shlx   %eax,%edx,%eax'],
    ['__libc_start_main', 'popcnt %rdi,%rax'],
    ['count', 'popcntq %rdi,%rax'],
    ['hash', 'crc32b %al,%ecx'],
    ['memcpy', 'pshufb %xmm1,%xmm0'],
    ['seed', 'lock cmpxchg16b (%rdi)'],
    ['mask', 'kmovw  %k1,%eax'],
    ['clean', 'verw   (%rdi)', 'tzcnt  %ecx,%ecx'],
  );
  assert.deepEqual(postBaselineFunctions(disassembly), [
    'main: vpxor %xmm1,%xmm1,%xmm1',
    'apply_policy: shlx %eax,%edx,%eax',
    '__libc_start_main: popcnt %rdi,%rax',
    'count: popcntq %rdi,%rax',
    'hash: crc32b %al,%ecx',
    'memcpy: pshufb %xmm1,%xmm0',
    'seed: lock cmpxchg16b (%rdi)',
    'mask: kmovw %k1,%eax',
  ]);
  assert.throws(() => assertBaselineX64('/fence', { disassemble: () => disassembly }), /main: vpxor.*SIGILL on older CPUs/s);
});

test('a listing with no function is not taken for a clean one', () => {
  assert.throws(() => assertBaselineX64('/fence', { disassemble: () => 'objdump: /fence: file format not recognized\n' }), /lists no function/);
});

test('the build stops before writing a launcher the guard refuses', (t) => {
  if (process.platform !== 'linux' || process.arch !== 'x64') { t.skip('needs a Linux x64 build machine'); return; }
  if (!compilerCandidates('x64').some((cc) => spawnSync(cc, ['--version'], { stdio: 'ignore' }).status === 0)) { t.skip('no C compiler'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'timon-fence-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'timon-fence');
  let checked = null;
  const refuse = (binary) => { checked = binary; throw new Error('needs AVX2'); };
  assert.throws(() => buildFence('x64', out, { checkBaseline: refuse, log: () => {} }), /needs AVX2/);
  assert.ok(checked && checked !== out, 'the guard reads a scratch build, not the shipped file');
  assert.equal(existsSync(out), false);
});
