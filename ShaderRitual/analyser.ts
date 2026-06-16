/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/** Thin wrapper around a Web Audio AnalyserNode for frequency data. */
export class Analyser {
  private analyser: AnalyserNode;
  private bufferLength = 0;
  private dataArray: Uint8Array;

  constructor(node: AudioNode) {
    this.analyser = node.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.bufferLength = this.analyser.frequencyBinCount;
    this.dataArray = new Uint8Array(this.bufferLength);
    node.connect(this.analyser);
  }

  update() {
    this.analyser.getByteFrequencyData(this.dataArray as any);
  }

  get data() {
    return this.dataArray;
  }

  set smoothing(value: number) {
    this.analyser.smoothingTimeConstant = value;
  }
}
