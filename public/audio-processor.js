class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Downsample to ~16kHz for voice (saves 3x bandwidth)
    this.downsampleFactor = Math.max(1, Math.round(sampleRate / 16000));
    this.targetRate = Math.round(sampleRate / this.downsampleFactor);
    this.buffer = [];
    this.bufferSize = 1600; // 100ms at 16kHz
    this.sampleIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const samples = input[0];
    for (let i = 0; i < samples.length; i++) {
      if (this.sampleIndex % this.downsampleFactor === 0) {
        this.buffer.push(samples[i]);
      }
      this.sampleIndex++;
    }

    if (this.buffer.length >= this.bufferSize) {
      const chunk = this.buffer.splice(0, this.bufferSize);
      const int16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      this.port.postMessage({ pcm: int16.buffer, rate: this.targetRate }, [int16.buffer]);
    }

    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
