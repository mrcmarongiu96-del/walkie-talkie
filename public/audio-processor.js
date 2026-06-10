// AudioWorklet: captures mic, downsamples to ~16 kHz, emits 100 ms Int16 PCM
// chunks plus an RMS level for the VU meter.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.downsampleFactor = Math.max(1, Math.round(sampleRate / 16000));
    this.targetRate = Math.round(sampleRate / this.downsampleFactor);
    this.buffer = [];
    this.bufferSize = Math.round(this.targetRate / 10); // 100 ms
    this.sampleIndex = 0;
    this.active = false;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.active = true; this.buffer = []; }
      if (e.data === 'stop') this.active = false;
    };
  }

  process(inputs) {
    if (!this.active) return true;
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0];
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSq += samples[i] * samples[i];
      if (this.sampleIndex % this.downsampleFactor === 0) {
        this.buffer.push(samples[i]);
      }
      this.sampleIndex++;
    }
    const rms = Math.sqrt(sumSq / samples.length);

    if (this.buffer.length >= this.bufferSize) {
      const chunk = this.buffer.splice(0, this.bufferSize);
      const int16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      this.port.postMessage(
        { pcm: int16.buffer, rate: this.targetRate, rms },
        [int16.buffer]
      );
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
