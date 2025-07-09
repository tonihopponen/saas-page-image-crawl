declare module 'probe-image-size' {
  interface ProbeResult {
    width: number;
    height: number;
    type: string;
    mime: string;
  }
  
  function probe(url: string): Promise<ProbeResult>;
  export = probe;
} 