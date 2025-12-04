export enum WorkerMessageType {
  Command,
  OutputMessage,
  BitStream,
  Error,
}

export type IWorkerCommandMessage = {
  type: WorkerMessageType.Command;
  command: string;
  args: string[];
};

export type IWorkerOutputMessage = {
  type: WorkerMessageType.OutputMessage;
  stream: 'stdout' | 'stderr';
  data: string;
};

export type IWorkerBitStreamMessage = {
  type: WorkerMessageType.BitStream;
  data: Uint8Array;
};

export type IWorkerErrorMessage = {
  type: WorkerMessageType.Error;
  message: string;
};

export type IWorkerMessage =
  | IWorkerCommandMessage
  | IWorkerOutputMessage
  | IWorkerBitStreamMessage
  | IWorkerErrorMessage;

export interface IWorkerJobData {
  sources: Record<string, string>;
  topModule: string;
}
