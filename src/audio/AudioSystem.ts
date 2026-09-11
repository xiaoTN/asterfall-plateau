import type { GameState, Settings, Vec3 } from '../core/types';
import { LOCATIONS } from '../config/game';

export type AudioPosition = Vec3 | { x: number; y: number; z: number };
type Channel = 'music' | 'ambient' | 'sfx';
interface Voice { bus: GainNode; nodes: AudioNode[]; sources: Set<AudioScheduledSourceNode>; }
interface Loop { gain: GainNode; source: AudioScheduledSourceNode; nodes: AudioNode[]; }
const DEFAULT_SETTINGS: Settings = { quality: 'high', volume: .7, music: .45, ambient: .65, sfx: .8, sensitivity: 1, shake: true, subtitles: true, colorblind: false };
const limit = (value: number, min = 0, max = 1): number => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const xyz = (position: AudioPosition): Vec3 => Array.isArray(position) ? position : [position.x, position.y, position.z];

/** Gesture-started, fully synthesized soundscape. No media requests or bundled samples. */
export class AudioSystem {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private channels: Partial<Record<Channel, GainNode>> = {};
  private noise: AudioBuffer | null = null;
  private brownNoise: AudioBuffer | null = null;
  private wind: Loop | null = null;
  private rain: Loop | null = null;
  private fire: Loop | null = null;
  private water: Loop | null = null;
  private pads: Loop[] = [];
  private voices = new Set<Voice>();
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private listener: Vec3 = [0, 0, 0];
  private yaw = 0;
  private state: GameState | null = null;
  private elapsed = 0;
  private stride = 0;
  private dripIn = 1.4;
  private birdIn = 8;
  private motifIn = 16;
  private fireIn = .4;
  private lastMovement = '';
  private lastPosition: Vec3 | null = null;
  private cooldowns = new Map<string, number>();
  private disposed = false;

  constructor() { /* AudioContext is intentionally deferred until start(). */ }

  /** Call from the Start/Continue click or another trusted user gesture. */
  public async start(): Promise<void> {
    if (this.disposed) return;
    if (!this.context) {
      const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Constructor) return;
      try {
        this.context = new Constructor();
        this.master = this.context.createGain();
        this.compressor = this.context.createDynamicsCompressor();
        this.compressor.threshold.value = -14;
        this.compressor.knee.value = 18;
        this.compressor.ratio.value = 5;
        this.compressor.attack.value = .005;
        this.compressor.release.value = .25;
        this.master.connect(this.compressor);
        this.compressor.connect(this.context.destination);
        for (const name of ['music', 'ambient', 'sfx'] as const) {
          const gain = this.context.createGain();
          gain.connect(this.master);
          this.channels[name] = gain;
        }
        this.noise = this.makeNoise(false);
        this.brownNoise = this.makeNoise(true);
        this.wind = this.noiseLoop('ambient', 530, 'lowpass', this.brownNoise);
        this.rain = this.noiseLoop('ambient', 2600, 'highpass', this.noise);
        this.fire = this.noiseLoop('ambient', 750, 'lowpass', this.noise);
        this.water = this.noiseLoop('ambient', 1250, 'bandpass', this.brownNoise);
        // A quiet open fifth with a suspended sixth: an original, non-melodic wind pad.
        [98, 146.832, 196.13, 261.63].forEach((frequency, i) => {
          const oscillator = this.context!.createOscillator();
          oscillator.type = i === 1 ? 'triangle' : 'sine';
          oscillator.frequency.value = frequency;
          oscillator.detune.value = [-4, 3, 1, -2][i]!;
          const gain = this.context!.createGain();
          gain.gain.value = 0;
          const filter = this.context!.createBiquadFilter();
          filter.type = 'lowpass'; filter.frequency.value = 480;
          oscillator.connect(filter); filter.connect(gain); gain.connect(this.channels.music!);
          oscillator.start();
          this.pads.push({ gain, source: oscillator, nodes: [filter] });
        });
        this.setSettings(this.settings);
      } catch {
        // Audio must never block a playable game (unsupported or denied device).
        this.disposeNodes();
        return;
      }
    }
    if (this.context?.state === 'suspended') {
      try { await this.context.resume(); } catch { /* A later user gesture may retry start(). */ }
    }
  }

  public setSettings(settings: Settings): void {
    this.settings = { ...settings };
    const context = this.context;
    if (!context || !this.master) return;
    this.smooth(this.master.gain, limit(settings.volume), .08);
    for (const channel of ['music', 'ambient', 'sfx'] as const) {
      const bus = this.channels[channel];
      if (bus) this.smooth(bus.gain, limit(settings[channel]), .08);
    }
  }

  /** dt is simulation time; position is the player's feet, +Y up, -Z forward. */
  public update(dt: number, state: GameState, position: AudioPosition = state.player.position): void {
    this.state = state;
    const p = xyz(position);
    this.listener = [p[0], p[1], p[2]];
    this.yaw = state.player.yaw;
    if (this.disposed || !this.context || this.context.state !== 'running') return;
    const delta = limit(dt, 0, .1);
    if (delta === 0) return;
    this.elapsed += delta;
    const underground = state.region !== 'overworld' || (!state.flags.exitedChamber && p[2] > 94 && Math.abs(p[0]) < 15);
    const night = state.time < 5.5 || state.time >= 20;
    const rainy = state.weather === 'rain' && !underground;
    const breeze = .075 + .035 * Math.sin(this.elapsed * .19) + .014 * Math.sin(this.elapsed * .71);
    if (this.wind) this.smooth(this.wind.gain.gain, underground ? .018 : breeze * (rainy ? 1.6 : 1), .6);
    if (this.rain) this.smooth(this.rain.gain.gain, rainy ? .065 : 0, .8);
    let fireDistance = Infinity;
    if (!underground && !rainy) {
      for (const id of ['elder', 'camp1', 'camp2', 'camp3', 'cabin']) {
        const location = LOCATIONS[id];
        if (location) fireDistance = Math.min(fireDistance, Math.hypot(p[0] - location.position[0], p[2] - location.position[2]));
      }
    }
    const fireLevel = Math.pow(limit(1 - fireDistance / 17), 2);
    if (this.fire) this.smooth(this.fire.gain.gain, fireLevel * (.035 + Math.random() * .014), .14);
    const lake = LOCATIONS.lake!;
    const waterDistance = Math.hypot(p[0] - lake.position[0], p[2] - lake.position[2]);
    if (this.water) this.smooth(this.water.gain.gain, underground ? .016 : Math.pow(limit(1 - waterDistance / 30), 2) * .075, .5);
    this.pads.forEach((pad, i) => {
      const breath = .45 + .4 * Math.sin(this.elapsed * .055 + i * 1.7);
      this.smooth(pad.gain.gain, (underground ? .011 : night ? .019 : .014) * breath * (i === 3 ? .48 : 1), 2);
    });
    if (this.lastPosition) {
      const moved = Math.hypot(p[0] - this.lastPosition[0], p[2] - this.lastPosition[2]);
      const movement = state.player.movement;
      if (moved < 3 && moved > .001 && ['run', 'sprint', 'crouch'].includes(movement)) {
        this.stride += moved;
        const strideLength = movement === 'sprint' ? 2.45 : movement === 'crouch' ? 1.45 : 1.9;
        if (this.stride >= strideLength) {
          this.stride %= strideLength;
          const snow = (p[0] < -38 && p[2] < -38) || p[1] > 37;
          this.play(underground ? 'step_stone' : snow ? 'step_snow' : rainy || waterDistance < 12 ? 'step_water' : 'step_grass');
        }
      } else if (['swim', 'climb'].includes(movement)) {
        this.stride += delta;
        if (this.stride > (movement === 'swim' ? .8 : .66)) { this.stride = 0; this.play(movement); }
      } else this.stride = 0;
      if (this.lastMovement !== movement) {
        if (movement === 'jump') this.play('jump');
        if (movement === 'glide') this.play('glide');
        if (movement === 'swim') this.play('splash');
        if (['fall', 'jump', 'glide'].includes(this.lastMovement) && ['idle', 'run', 'sprint'].includes(movement) && moved < 3) this.play('land');
      }
      this.lastMovement = movement;
    }
    this.lastPosition = [p[0], p[1], p[2]];
    this.dripIn -= delta;
    if (underground && this.dripIn <= 0) { this.play('drip', [p[0] + Math.random() * 12 - 6, p[1] + 2, p[2] - 3]); this.dripIn = 1.8 + Math.random() * 4; }
    this.birdIn -= delta;
    if (!underground && !rainy && !night && this.birdIn <= 0) { this.play('bird', [p[0] + 8 + Math.random() * 10, p[1] + 5, p[2] - 8]); this.birdIn = 12 + Math.random() * 21; }
    this.fireIn -= delta;
    if (fireLevel > .02 && this.fireIn <= 0) { this.play('fire', [p[0] + fireDistance * .5, p[1], p[2]]); this.fireIn = .3 + Math.random() * .9; }
    this.motifIn -= delta;
    if (this.motifIn <= 0) {
      this.motifIn = 28 + Math.random() * 33;
      const voice = this.voice('music', .09);
      if (voice) {
        const motif = night ? [293.66, 220, 261.63, 146.83] : [196, 293.66, 329.63, 261.63];
        motif.forEach((frequency, i) => this.tone(voice, frequency, 2.4, .18, 'sine', i * 1.15, undefined, .04));
      }
    }
    const audioTime = this.context.currentTime;
    if (this.cooldowns.size > 80) this.cooldowns.forEach((time, name) => { if (audioTime - time > 3) this.cooldowns.delete(name); });
  }

  /** Named one-shots accept either a THREE.Vector3-compatible object or a tuple. */
  public play(name: string, position?: AudioPosition): void {
    if (this.disposed || !this.context || this.context.state !== 'running') return;
    const event = name.toLowerCase().replace(/[\s_:-]/g, '');
    const now = this.context.currentTime;
    const interval = /step|foot|fire|hit|attack|swing/.test(event) ? .075 : .12;
    if (now - (this.cooldowns.get(event) ?? -100) < interval) return;
    this.cooldowns.set(event, now);
    const distance = position ? Math.hypot(...xyz(position).map((n, i) => n - this.listener[i]!)) : 0;
    if (distance > 85) return;
    const ambient = /^(drip|bird|fire|wind|waterfall)$/.test(event);
    const voice = this.voice(ambient ? 'ambient' : 'sfx', 1 / (1 + distance * distance / 120), position);
    if (!voice) return;
    if (/step|foot/.test(event)) {
      const quiet = this.state?.player.movement === 'crouch' ? .4 : 1;
      const stone = /stone|rock/.test(event);
      this.noiseBurst(voice, stone ? .06 : /water/.test(event) ? .16 : .11, .07 * quiet, stone ? 1700 : 800, 'bandpass');
      this.tone(voice, stone ? 170 : 100, .07, .08 * quiet, 'sine', 0, 45);
      if (/snow|grass/.test(event)) this.noiseBurst(voice, .085, .025 * quiet, 3000, 'highpass', .03);
    } else if (/explos|detonat|bombexplode|blast/.test(event)) {
      this.noiseBurst(voice, .95, .48, 1800, 'lowpass');
      this.tone(voice, 140, .7, .54, 'sine', 0, 28);
      this.noiseBurst(voice, .35, .15, 3100, 'bandpass', .04);
    } else if (/parry|perfect|deflect/.test(event)) {
      this.noiseBurst(voice, .06, .17, 4000, 'highpass');
      [659.25, 987.77, 1318.5].forEach((f, i) => this.tone(voice, f, .6 + i * .1, .16 / (i + 1), 'sine', i * .035));
    } else if (/death|gameover/.test(event)) {
      [220, 164.81, 130.81, 98].forEach((f, i) => this.tone(voice, f, 1.5, .14, 'triangle', i * .25, f * .95, .04));
      this.noiseBurst(voice, 1.6, .09, 450, 'lowpass');
    } else if (/damage|hurt|pain/.test(event)) {
      this.noiseBurst(voice, .19, .21, 660, 'lowpass');
      this.tone(voice, 160, .18, .23, 'triangle', 0, 60);
    } else if (/hit|impact|strike|chop/.test(event)) {
      this.noiseBurst(voice, .12, .2, /metal/.test(event) ? 3200 : 1300, 'bandpass');
      this.tone(voice, /metal/.test(event) ? 710 : 180, .13, .17, 'triangle', 0, /metal/.test(event) ? 440 : 72);
    } else if (/break|shatter/.test(event)) {
      for (let i = 0; i < 5; i++) { this.noiseBurst(voice, .1, .12, 1900 + i * 600, 'bandpass', i * .035); this.tone(voice, 620 + i * 147, .12, .04, 'triangle', i * .04); }
    } else if (/attack|swing|slash|throw/.test(event)) {
      this.noiseBurst(voice, .17, .14, 1400, 'bandpass');
      this.tone(voice, 140, .12, .035, 'triangle', 0, 70);
    } else if (/arrow|shoot|bowrelease/.test(event)) {
      this.noiseBurst(voice, .12, .11, 3200, 'highpass');
      this.tone(voice, 380, .15, .08, 'triangle', 0, 100);
    } else if (/bow|draw/.test(event)) {
      this.noiseBurst(voice, .25, .045, 1200, 'bandpass');
      this.tone(voice, 160, .25, .035, 'triangle', 0, 300, .025);
    } else if (/tower|rumble|bloodmoon/.test(event)) {
      this.noiseBurst(voice, 2.8, .22, 350, 'lowpass');
      [49, 73.42, 98].forEach((f, i) => this.tone(voice, f, 2.7, .14, 'sine', i * .1, f * (/blood/.test(event) ? .8 : 1.05), .15));
    } else if (/chest|reward|quest|success|complete|upgrade|gliderget/.test(event)) {
      [392, 523.25, 587.33, 783.99].forEach((f, i) => this.tone(voice, f, .75, .14, 'sine', i * .14));
      this.tone(voice, 196, 1.3, .08, 'triangle', 0, undefined, .04);
    } else if (/cook|meal/.test(event)) {
      [330, 440, 550, 660, 880].forEach((f, i) => { this.tone(voice, f, .19, .1, 'sine', i * .11, f * .85); this.noiseBurst(voice, .08, .025, 1000, 'bandpass', i * .11); });
    } else if (/eat|drink/.test(event)) {
      [0, .13, .25].forEach(offset => this.noiseBurst(voice, .08, .06, 900, 'bandpass', offset));
      this.tone(voice, 523.25, .28, .065, 'sine', .3);
    } else if (/stasis|freeze|time/.test(event)) {
      [294, 588, 881].forEach((f, i) => this.tone(voice, f, .7, .09 / (i + 1), 'triangle', i * .07, f * .98));
      this.noiseBurst(voice, .25, .07, 1800, 'bandpass');
    } else if (/ice|frost/.test(event)) {
      this.noiseBurst(voice, .65, .15, 2500, 'highpass');
      [880, 1320, 1760].forEach((f, i) => this.tone(voice, f, .5, .065, 'sine', i * .07, f * .92));
    } else if (/magnet|metal|ability|terminal|unlock|download/.test(event)) {
      this.tone(voice, 196, .65, .12, 'sine', 0, 392, .025);
      this.tone(voice, 588, .6, .07, 'sine', .1, 784, .02);
      this.noiseBurst(voice, .25, .035, 1800, 'bandpass', .06);
    } else if (/bomb|place/.test(event)) {
      this.tone(voice, 392, .22, .14, 'sine', 0, 196);
      this.tone(voice, 784, .18, .06, 'sine', .13);
    } else if (/door|gate|stone|treefall/.test(event)) {
      this.noiseBurst(voice, 1.2, .2, 450, 'lowpass');
      this.tone(voice, 65, .9, .08, 'triangle', 0, 40, .04);
    } else if (/alert|enemy|horn/.test(event)) {
      this.tone(voice, 196, .48, .09, 'sawtooth', 0, 233, .04);
      this.tone(voice, 293.66, .45, .055, 'triangle', .08);
    } else if (/swim|splash|water/.test(event)) {
      this.noiseBurst(voice, /splash/.test(event) ? .5 : .3, .095, 1200, 'bandpass');
      this.tone(voice, 220, .15, .04, 'sine', .05, 110);
    } else if (/climb|land|jump|dodge|glide/.test(event)) {
      this.noiseBurst(voice, /glide/.test(event) ? .6 : .15, /land/.test(event) ? .13 : .065, 750, 'bandpass');
      if (/land/.test(event)) this.tone(voice, 105, .15, .12, 'sine', 0, 48);
    } else if (/drip/.test(event)) {
      const f = 650 + Math.random() * 450;
      this.tone(voice, f, .23, .06, 'sine', 0, f * .6);
      this.tone(voice, f * .7, .3, .025, 'sine', .15, f * .6);
    } else if (/bird/.test(event)) {
      [0, .18, .45].forEach((offset, i) => this.tone(voice, 1700 + i * 210, .13, .05, 'sine', offset, 2400 - i * 130));
    } else if (/fire/.test(event)) {
      this.noiseBurst(voice, .035 + Math.random() * .045, .075, 1900, 'highpass');
    } else if (/wind/.test(event)) {
      this.noiseBurst(voice, 1.8, .1, 800, 'lowpass');
    } else if (/pickup|collect|equip|save|click|select|ui|ready/.test(event)) {
      this.tone(voice, 659.25, .13, .09, 'sine');
      this.tone(voice, 987.77, .2, .06, 'sine', .07);
    } else {
      // Unknown event names still receive a discreet, bounded interaction response.
      this.tone(voice, 440, .1, .045, 'sine');
    }
    if (voice.sources.size === 0) this.release(voice);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeNodes();
    this.cooldowns.clear();
    this.state = null;
    this.lastPosition = null;
  }

  private smooth(parameter: AudioParam, value: number, seconds: number): void {
    if (!this.context) return;
    parameter.setTargetAtTime(value, this.context.currentTime, seconds);
  }

  private makeNoise(brown: boolean): AudioBuffer {
    const context = this.context!;
    const length = Math.ceil(context.sampleRate * 3);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const channel = buffer.getChannelData(0);
    let previous = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      previous = (previous + .025 * white) / 1.025;
      const edge = Math.min(1, i / 120, (length - 1 - i) / 120);
      channel[i] = (brown ? previous * 3.5 : white) * edge;
    }
    return buffer;
  }

  private noiseLoop(channel: Channel, frequency: number, type: BiquadFilterType, buffer: AudioBuffer): Loop {
    const context = this.context!;
    const source = context.createBufferSource();
    source.buffer = buffer; source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = type; filter.frequency.value = frequency; filter.Q.value = .6;
    const gain = context.createGain(); gain.gain.value = 0;
    source.connect(filter); filter.connect(gain); gain.connect(this.channels[channel]!);
    source.start(0, Math.random());
    return { gain, source, nodes: [filter] };
  }

  private voice(channel: Channel, amplitude: number, position?: AudioPosition): Voice | null {
    const context = this.context;
    if (!context || !this.channels[channel] || this.voices.size >= 32) return null;
    const bus = context.createGain(); bus.gain.value = limit(amplitude);
    const voice: Voice = { bus, nodes: [], sources: new Set() };
    if (position) {
      const p = xyz(position);
      const dx = p[0] - this.listener[0]; const dz = p[2] - this.listener[2];
      const distance = Math.max(1, Math.hypot(dx, dz));
      const pan = context.createStereoPanner();
      pan.pan.value = limit((dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw)) / distance, -.85, .85);
      bus.connect(pan); pan.connect(this.channels[channel]!); voice.nodes.push(pan);
    } else bus.connect(this.channels[channel]!);
    this.voices.add(voice);
    return voice;
  }

  private tone(voice: Voice, frequency: number, duration: number, amplitude: number, type: OscillatorType = 'sine', delay = 0, endFrequency?: number, attack = .007): void {
    const context = this.context!;
    const start = context.currentTime + delay;
    const source = context.createOscillator();
    source.type = type;
    source.frequency.setValueAtTime(frequency, start);
    if (endFrequency !== undefined) source.frequency.exponentialRampToValueAtTime(Math.max(15, endFrequency), start + duration);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(.0002, amplitude), start + Math.min(attack, duration * .2));
    envelope.gain.exponentialRampToValueAtTime(.0001, start + duration);
    source.connect(envelope); envelope.connect(voice.bus);
    voice.nodes.push(envelope);
    this.track(voice, source);
    source.start(start); source.stop(start + duration + .02);
  }

  private noiseBurst(voice: Voice, duration: number, amplitude: number, frequency: number, type: BiquadFilterType, delay = 0): void {
    const context = this.context!;
    const start = context.currentTime + delay;
    const source = context.createBufferSource(); source.buffer = this.noise;
    const filter = context.createBiquadFilter(); filter.type = type; filter.frequency.value = frequency; filter.Q.value = .75;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(.0001, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(.0002, amplitude), start + .008);
    envelope.gain.exponentialRampToValueAtTime(.0001, start + Math.max(.02, duration));
    source.connect(filter); filter.connect(envelope); envelope.connect(voice.bus);
    voice.nodes.push(filter, envelope);
    this.track(voice, source);
    source.start(start, Math.random() * Math.max(0, 3 - duration)); source.stop(start + duration + .02);
  }

  private track(voice: Voice, source: AudioScheduledSourceNode): void {
    voice.sources.add(source);
    source.onended = () => {
      source.disconnect(); voice.sources.delete(source);
      if (voice.sources.size === 0) this.release(voice);
    };
  }

  private release(voice: Voice): void {
    voice.sources.forEach(source => { source.onended = null; try { source.stop(); } catch { /* Already stopped. */ } source.disconnect(); });
    voice.sources.clear();
    voice.nodes.forEach(node => node.disconnect());
    voice.bus.disconnect();
    this.voices.delete(voice);
  }

  private disposeNodes(): void {
    this.voices.forEach(voice => this.release(voice));
    for (const loop of [this.wind, this.rain, this.fire, this.water, ...this.pads]) {
      if (!loop) continue;
      try { loop.source.stop(); } catch { /* A partially initialized source may not have started. */ }
      loop.source.disconnect(); loop.gain.disconnect(); loop.nodes.forEach(node => node.disconnect());
    }
    this.pads = []; this.wind = null; this.rain = null; this.fire = null; this.water = null;
    Object.values(this.channels).forEach(channel => channel?.disconnect()); this.channels = {};
    this.master?.disconnect(); this.master = null;
    this.compressor?.disconnect(); this.compressor = null;
    const context = this.context; this.context = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
    this.noise = null; this.brownNoise = null;
  }
}
