import { create } from 'zustand';

/**
 * Alert chimes synthesized with Web Audio (no audio files, CSP-friendly).
 * Browsers only allow audio after a user gesture, so the context is created/resumed on the
 * first click or keypress; until then `blocked` is true (Settings explains this next to the sound toggle).
 */
let ctx: AudioContext | null = null;

export const useAudioState = create<{ blocked: boolean }>(() => ({ blocked: true }));

function update() {
  useAudioState.setState({ blocked: !ctx || ctx.state !== 'running' });
}

export function unlockAudio() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume().then(update);
    update();
  } catch {
    /* Web Audio unavailable */
  }
}

if (typeof window !== 'undefined') {
  const onGesture = () => unlockAudio();
  window.addEventListener('pointerdown', onGesture, { capture: true });
  window.addEventListener('keydown', onGesture, { capture: true });
}

const NOTES: Record<'call' | 'flip' | 'control', number[]> = {
  call: [880, 1174.66],
  flip: [659.25, 880, 1318.51],
  control: [523.25, 659.25, 783.99, 1046.5],
};

export function chime(kind: 'call' | 'flip' | 'control') {
  if (!ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime + 0.02;
  NOTES[kind].forEach((f, i) => {
    const osc = ctx!.createOscillator();
    const gain = ctx!.createGain();
    osc.type = 'triangle';
    osc.frequency.value = f;
    const t = t0 + i * 0.16;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.22, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'control' ? 0.9 : 0.5));
    osc.connect(gain).connect(ctx!.destination);
    osc.start(t);
    osc.stop(t + 1);
  });
}
