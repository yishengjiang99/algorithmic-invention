/*
 * Band-limited mipmapped wavetable oscillator.
 * Freestanding C → wasm32. No malloc, no libm, no WASI.
 * Memory is fixed at one 64 KiB page (no grow).
 *
 * Visible in the HTML source; compiled in the browser by wabt (jsDelivr).
 */

#define TABLE 1024
#define TABLE_MASK 1023
#define TABLES 6
#define MAX_VOICES 32
#define OUT_CAP 256
#define WAVES 2

#define WAVE_SAW 0
#define WAVE_SQR 1

#define FLAG_NAN 1
#define FLAG_INF 2

static float tables[WAVES][TABLES][TABLE];
static float phase[MAX_VOICES];
static float freq[MAX_VOICES];
static float freq_tgt[MAX_VOICES];
static float gain[MAX_VOICES];
static float gain_tgt[MAX_VOICES];
static float out[OUT_CAP];

static unsigned n_voices = 1;
static unsigned wave = WAVE_SAW;
static float sr = 48000.0f;
static float inv_sr = 1.0f / 48000.0f;
static float gain_ramp = 0.0f;
static float freq_ramp = 0.0f;
static unsigned g_nan = 0;
static unsigned g_inf = 0;
static unsigned g_ready = 0;

static float sinf_approx(float x)
{
    const float pi = 3.14159265358979323846f;
    const float half_pi = 1.5707963267948966f;
    const float tau = 6.283185307179586f;
    float t = x - tau * (float)(int)(x / tau);
    if (t < 0.0f)
        t += tau;
    float sign = 1.0f;
    if (t > pi) {
        t -= pi;
        sign = -1.0f;
    }
    if (t > half_pi)
        t = pi - t;
    float t2 = t * t;
    return sign * t *
           (1.0f +
            t2 * (-0.166666567f +
                  t2 * (0.008333026f + t2 * (-0.00019807418f + t2 * 0.0000026019f))));
}

static int table_index(float f)
{
    int t = 0;
    float edge = 110.0f;
    while (t < TABLES - 1 && f >= edge) {
        edge *= 2.0f;
        t += 1;
    }
    return t;
}

static void build_tables(void)
{
    float nyq = sr * 0.5f;
    for (int w = 0; w < WAVES; w++) {
        for (int t = 0; t < TABLES; t++) {
            float f_hi = (t == TABLES - 1) ? nyq : (110.0f * (float)(1 << t));
            int n_harm = (int)(nyq / f_hi);
            if (n_harm < 1)
                n_harm = 1;
            if (n_harm > 256)
                n_harm = 256;
            float peak = 1.0e-12f;
            for (int i = 0; i < TABLE; i++) {
                float acc = 0.0f;
                float pos = (float)i / (float)TABLE;
                for (int h = 1; h <= n_harm; h++) {
                    if (w == WAVE_SQR && (h & 1) == 0)
                        continue;
                    acc += sinf_approx(6.28318530718f * (float)h * pos) / (float)h;
                }
                tables[w][t][i] = acc;
                float a = acc < 0.0f ? -acc : acc;
                if (a > peak)
                    peak = a;
            }
            float s = 0.85f / peak;
            for (int i = 0; i < TABLE; i++)
                tables[w][t][i] *= s;
        }
    }
}

__attribute__((export_name("init"))) void init(float sample_rate)
{
    if (sample_rate < 8000.0f)
        sample_rate = 48000.0f;
    sr = sample_rate;
    inv_sr = 1.0f / sr;
    gain_ramp = 1.0f / (0.005f * sr);
    if (gain_ramp > 1.0f)
        gain_ramp = 1.0f;
    freq_ramp = 1.0f / (0.008f * sr);
    if (freq_ramp > 1.0f)
        freq_ramp = 1.0f;
    n_voices = 1;
    wave = WAVE_SAW;
    g_nan = 0;
    g_inf = 0;
    for (int i = 0; i < MAX_VOICES; i++) {
        phase[i] = 0.0f;
        freq[i] = 220.0f;
        freq_tgt[i] = 220.0f;
        gain[i] = 0.0f;
        gain_tgt[i] = 0.0f;
    }
    build_tables();
    g_ready = 1;
}

__attribute__((export_name("set_voices"))) void set_voices(int n)
{
    if (n < 1)
        n = 1;
    if (n > MAX_VOICES)
        n = MAX_VOICES;
    n_voices = (unsigned)n;
}

__attribute__((export_name("set_wave"))) void set_wave(int w)
{
    wave = (w == WAVE_SQR) ? WAVE_SQR : WAVE_SAW;
}

__attribute__((export_name("set_voice"))) void set_voice(int i, float f, float g)
{
    if (i < 0 || i >= MAX_VOICES)
        return;
    if (f < 20.0f)
        f = 20.0f;
    if (f > 8000.0f)
        f = 8000.0f;
    if (g < 0.0f)
        g = 0.0f;
    if (g > 1.0f)
        g = 1.0f;
    freq_tgt[i] = f;
    gain_tgt[i] = g;
}

__attribute__((export_name("note_off_all"))) void note_off_all(void)
{
    for (int i = 0; i < MAX_VOICES; i++)
        gain_tgt[i] = 0.0f;
}

__attribute__((export_name("out_ptr"))) float *out_ptr(void) { return out; }
__attribute__((export_name("freq_tgt_ptr"))) float *freq_tgt_ptr(void) { return freq_tgt; }
__attribute__((export_name("gain_tgt_ptr"))) float *gain_tgt_ptr(void) { return gain_tgt; }
__attribute__((export_name("nan_count"))) unsigned nan_count(void) { return g_nan; }
__attribute__((export_name("inf_count"))) unsigned inf_count(void) { return g_inf; }
__attribute__((export_name("ready"))) unsigned ready(void) { return g_ready; }
__attribute__((export_name("mem_bytes"))) int mem_bytes(void) { return 65536; }
__attribute__((export_name("reset_stats"))) void reset_stats(void)
{
    g_nan = 0;
    g_inf = 0;
}

__attribute__((export_name("render"))) int render(int n)
{
    if (n < 1)
        n = 1;
    if (n > OUT_CAP)
        n = OUT_CAP;

    unsigned wv = wave;
    unsigned nv = n_voices;
    int flags = 0;
    float g_ramp = gain_ramp;
    float f_ramp = freq_ramp;
    float isr = inv_sr;

    for (int s = 0; s < n; s++) {
        float mix = 0.0f;
        for (unsigned v = 0; v < nv; v++) {
            float fr = freq[v] + (freq_tgt[v] - freq[v]) * f_ramp;
            freq[v] = fr;
            float gn = gain[v] + (gain_tgt[v] - gain[v]) * g_ramp;
            gain[v] = gn;
            if (gn < 1.0e-6f && gain_tgt[v] < 1.0e-6f)
                continue;

            float ph = phase[v] + fr * isr;
            ph -= (float)(int)ph;
            if (ph < 0.0f)
                ph += 1.0f;
            phase[v] = ph;

            int t = table_index(fr);
            float idx = ph * (float)TABLE;
            int i0 = (int)idx;
            float frac = idx - (float)i0;
            i0 &= TABLE_MASK;
            int i1 = (i0 + 1) & TABLE_MASK;
            float a = tables[wv][t][i0];
            float b = tables[wv][t][i1];
            mix += (a + (b - a) * frac) * gn;
        }
        if (mix > 1.0f)
            mix = 1.0f;
        else if (mix < -1.0f)
            mix = -1.0f;
        out[s] = mix;
    }

    for (int s = 0; s < n; s++) {
        float x = out[s];
        if (x != x) {
            g_nan += 1;
            flags |= FLAG_NAN;
            out[s] = 0.0f;
        } else if (x > 1.0e16f || x < -1.0e16f) {
            g_inf += 1;
            flags |= FLAG_INF;
            out[s] = 0.0f;
        }
    }
    return flags;
}

__attribute__((export_name("voice_gain"))) float voice_gain(int i)
{
    if (i < 0 || i >= MAX_VOICES)
        return 0.0f;
    return gain[i];
}
