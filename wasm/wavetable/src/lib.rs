#![no_std]
#![no_main]

//! Band-limited mipmapped wavetable oscillator.
//! Memory is a single 64 KiB page with a hard max of 1 page — growth is impossible.

const TABLE: usize = 1024;
const TABLE_MASK: usize = TABLE - 1;
const TABLES: usize = 6;
const WAVES: usize = 2;
const MAX_VOICES: usize = 32;
const OUT_CAP: usize = 256;

const WAVE_SAW: u32 = 0;
const WAVE_SQR: u32 = 1;

const PI: f32 = 3.14159265;
const TAU: f32 = 6.2831853;

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

struct State {
    tables: [[[f32; TABLE]; TABLES]; WAVES],
    phase: [f32; MAX_VOICES],
    freq: [f32; MAX_VOICES],
    freq_tgt: [f32; MAX_VOICES],
    gain: [f32; MAX_VOICES],
    gain_tgt: [f32; MAX_VOICES],
    out: [f32; OUT_CAP],
    n_voices: u32,
    wave: u32,
    sr: f32,
    inv_sr: f32,
    gain_ramp: f32,
    freq_ramp: f32,
    nan_count: u32,
    inf_count: u32,
    ready: u32,
}

impl State {
    const fn zero() -> Self {
        Self {
            tables: [[[0.0; TABLE]; TABLES]; WAVES],
            phase: [0.0; MAX_VOICES],
            freq: [0.0; MAX_VOICES],
            freq_tgt: [0.0; MAX_VOICES],
            gain: [0.0; MAX_VOICES],
            gain_tgt: [0.0; MAX_VOICES],
            out: [0.0; OUT_CAP],
            n_voices: 1,
            wave: 0,
            sr: 48000.0,
            inv_sr: 1.0 / 48000.0,
            gain_ramp: 0.0,
            freq_ramp: 0.0,
            nan_count: 0,
            inf_count: 0,
            ready: 0,
        }
    }
}

use core::mem::MaybeUninit;
use core::ptr;

static mut STATE: MaybeUninit<State> = MaybeUninit::uninit();

#[inline]
unsafe fn state() -> &'static mut State {
    STATE.assume_init_mut()
}

#[inline]
fn wrap_unit(x: f32) -> f32 {
    let mut t = x;
    if t >= 1.0 {
        t -= t as u32 as f32;
    }
    if t < 0.0 {
        t += 1.0;
        if t < 0.0 {
            t = 0.0;
        }
    }
    t
}

#[inline]
fn sinf(x: f32) -> f32 {
    // Software sine: wasm32 has no f32.sin. 7-term Taylor after reduction to [0, π/2].
    let mut t = x;
    if t < 0.0 {
        t = -t;
    }
    let k = (t * (1.0 / TAU)) as u32;
    t -= k as f32 * TAU;
    let mut sign = 1.0f32;
    if t > PI {
        t -= PI;
        sign = -1.0;
    }
    if t > PI * 0.5 {
        t = PI - t;
    }
    let t2 = t * t;
    sign
        * t
        * (1.0
            + t2
                * (-0.166666567
                    + t2
                        * (0.0083330257
                            + t2 * (-0.00019807418 + t2 * 0.0000026019033))))
}

#[inline]
fn table_index(freq: f32) -> usize {
    // Tables cover <110, <220, <440, <880, <1760, else.
    let mut t = 0usize;
    let mut edge = 110.0f32;
    while t + 1 < TABLES && freq >= edge {
        edge *= 2.0;
        t += 1;
    }
    t
}

fn harmonics_for_table(t: usize, sr: f32) -> i32 {
    let nyq = sr * 0.5;
    let f_hi = if t + 1 == TABLES {
        nyq
    } else {
        110.0 * (1u32 << t) as f32
    };
    let n = (nyq / f_hi) as i32;
    if n < 1 {
        1
    } else if n > 512 {
        512
    } else {
        n
    }
}

fn build_tables(s: &mut State) {
    let sr = s.sr;
    for wave in 0..WAVES {
        for t in 0..TABLES {
            let n_harm = harmonics_for_table(t, sr);
            let mut peak = 1.0e-12f32;
            for i in 0..TABLE {
                let phase = i as f32 / TABLE as f32;
                let mut acc = 0.0f32;
                let mut h = 1i32;
                while h <= n_harm {
                    if wave == WAVE_SQR as usize && (h & 1) == 0 {
                        h += 1;
                        continue;
                    }
                    acc += sinf(TAU * h as f32 * phase) / h as f32;
                    h += 1;
                }
                s.tables[wave][t][i] = acc;
                let a = if acc < 0.0 { -acc } else { acc };
                if a > peak {
                    peak = a;
                }
            }
            let scale = 0.85 / peak;
            for i in 0..TABLE {
                s.tables[wave][t][i] *= scale;
            }
        }
    }
}

#[inline]
fn lerp_table(table: &[f32; TABLE], phase: f32) -> f32 {
    let x = phase * TABLE as f32;
    let i0 = x as usize & TABLE_MASK;
    let i1 = (i0 + 1) & TABLE_MASK;
    let frac = x - (x as u32 as f32);
    // Safety: i0/i1 masked into 0..1023.
    unsafe {
        table.get_unchecked(i0) * (1.0 - frac) + table.get_unchecked(i1) * frac
    }
}

#[no_mangle]
pub extern "C" fn init(sr: f32) {
    unsafe {
        let s = STATE.as_mut_ptr();
        ptr::write_bytes(s, 0, 1);
        let s = &mut *s;
        s.sr = if sr > 1000.0 { sr } else { 48000.0 };
        s.inv_sr = 1.0 / s.sr;
        // ~5 ms gain time constant, ~8 ms pitch time constant.
        s.gain_ramp = 1.0 - libexp(-1.0 / (0.005 * s.sr));
        s.freq_ramp = 1.0 - libexp(-1.0 / (0.008 * s.sr));
        s.n_voices = 1;
        s.wave = WAVE_SAW;
        s.nan_count = 0;
        s.inf_count = 0;
        for i in 0..MAX_VOICES {
            s.phase[i] = 0.0;
            s.freq[i] = 220.0;
            s.freq_tgt[i] = 220.0;
            s.gain[i] = 0.0;
            s.gain_tgt[i] = 0.0;
        }
        build_tables(s);
        s.ready = 1;
    }
}

/// Cheap e^x for |x| small (ramp coefficients). 4-term Taylor of exp.
#[inline]
fn libexp(x: f32) -> f32 {
    let x2 = x * x;
    1.0 + x + 0.5 * x2 + (1.0 / 6.0) * x2 * x
}

#[no_mangle]
pub extern "C" fn set_voices(n: i32) {
    unsafe {
        let n = if n < 1 {
            1
        } else if n as usize > MAX_VOICES {
            MAX_VOICES as i32
        } else {
            n
        };
        state().n_voices = n as u32;
    }
}

#[no_mangle]
pub extern "C" fn set_wave(w: i32) {
    unsafe {
        state().wave = if w == 0 { WAVE_SAW } else { WAVE_SQR };
    }
}

#[no_mangle]
pub extern "C" fn set_voice(i: i32, freq: f32, gain: f32) {
    if i < 0 || i as usize >= MAX_VOICES {
        return;
    }
    let i = i as usize;
    let f = if freq.is_finite() {
        freq.clamp(20.0, 8000.0)
    } else {
        220.0
    };
    let g = if gain.is_finite() {
        gain.clamp(0.0, 1.0)
    } else {
        0.0
    };
    unsafe {
        let s = state();
        s.freq_tgt[i] = f;
        s.gain_tgt[i] = g;
    }
}

#[no_mangle]
pub extern "C" fn note_off_all() {
    unsafe {
        for i in 0..MAX_VOICES {
            state().gain_tgt[i] = 0.0;
        }
    }
}

#[no_mangle]
pub extern "C" fn reset_stats() {
    unsafe {
        let s = state();
        s.nan_count = 0;
        s.inf_count = 0;
    }
}

#[no_mangle]
pub extern "C" fn nan_count() -> u32 {
    unsafe { state().nan_count }
}

#[no_mangle]
pub extern "C" fn inf_count() -> u32 {
    unsafe { state().inf_count }
}

#[no_mangle]
pub extern "C" fn ready() -> u32 {
    unsafe { state().ready }
}

#[no_mangle]
pub extern "C" fn out_ptr() -> i32 {
    unsafe { state().out.as_ptr() as i32 }
}

#[no_mangle]
pub extern "C" fn freq_tgt_ptr() -> i32 {
    unsafe { state().freq_tgt.as_ptr() as i32 }
}

#[no_mangle]
pub extern "C" fn gain_tgt_ptr() -> i32 {
    unsafe { state().gain_tgt.as_ptr() as i32 }
}

#[no_mangle]
pub extern "C" fn mem_bytes() -> i32 {
    // Fixed: one WASM page. Exposed so JS can assert no growth.
    65536
}

/// Render `n` samples into the internal out buffer. Returns a flags word:
/// bit 0 = non-finite sample seen this call.
#[no_mangle]
pub extern "C" fn render(n: i32) -> i32 {
    unsafe {
        let s = state();
        let n = if n < 1 {
            1
        } else if n as usize > OUT_CAP {
            OUT_CAP
        } else {
            n as usize
        };
        let voices = s.n_voices as usize;
        let voices = if voices == 0 {
            1
        } else if voices > MAX_VOICES {
            MAX_VOICES
        } else {
            voices
        };
        let wave = if s.wave == WAVE_SQR { 1 } else { 0 };
        let inv_sr = s.inv_sr;
        let gain_ramp = s.gain_ramp;
        let freq_ramp = s.freq_ramp;
        let mut flags = 0i32;

        let out = &mut s.out;
        for i in 0..n {
            out[i] = 0.0;
        }

        for v in 0..voices {
            let mut freq = s.freq[v] + (s.freq_tgt[v] - s.freq[v]) * freq_ramp;
            if (freq - s.freq_tgt[v]).abs() < 0.001 {
                freq = s.freq_tgt[v];
            }
            s.freq[v] = freq;

            let mut gain = s.gain[v] + (s.gain_tgt[v] - s.gain[v]) * gain_ramp;
            if (gain - s.gain_tgt[v]).abs() < 1.0e-6 {
                gain = s.gain_tgt[v];
            }
            s.gain[v] = gain;

            if gain <= 1.0e-8 {
                // Keep phase advancing so note-on is phase-continuous.
                let ph = wrap_unit(s.phase[v] + freq * inv_sr * n as f32);
                s.phase[v] = ph;
                continue;
            }

            let tix = table_index(freq);
            let table = &s.tables[wave][tix];
            let inc = freq * inv_sr;
            let mut ph = s.phase[v];
            let g = gain;
            for i in 0..n {
                let sample = lerp_table(table, ph);
                out[i] += sample * g;
                ph += inc;
                if ph >= 1.0 {
                    ph -= 1.0;
                }
            }
            s.phase[v] = ph;
        }

        for i in 0..n {
            let x = out[i];
            if !x.is_finite() {
                flags |= 1;
                if x.is_nan() {
                    s.nan_count = s.nan_count.saturating_add(1);
                } else {
                    s.inf_count = s.inf_count.saturating_add(1);
                }
                out[i] = 0.0;
            }
        }
        flags
    }
}
