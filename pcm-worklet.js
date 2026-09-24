// Forwards raw microphone samples from the audio thread in ~85 ms batches.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.length = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      let offset = 0;
      while (offset < channel.length) {
        const n = Math.min(channel.length - offset, this.buffer.length - this.length);
        this.buffer.set(channel.subarray(offset, offset + n), this.length);
        this.length += n;
        offset += n;
        if (this.length === this.buffer.length) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(4096);
          this.length = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
