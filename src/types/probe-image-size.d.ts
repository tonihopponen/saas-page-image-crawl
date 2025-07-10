declare module 'probe-image-size' {
  interface ProbeResult {
    width: number;
    height: number;
    type: string;
    mime: string;
  }
  function probe(input: string | Buffer): Promise<ProbeResult>;
  export = probe;
} 