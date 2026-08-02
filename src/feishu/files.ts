import { Readable } from 'node:stream';

import type { OutgoingFile } from '../types.js';

export const FEISHU_MAX_FILE_UPLOAD_BYTES = 30 * 1024 * 1024;
export const FEISHU_MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

export class FeishuUploadRejectedError extends Error {
  constructor(reason: string) {
    super(`Feishu upload rejected: ${reason}`);
    this.name = 'FeishuUploadRejectedError';
  }
}

export function assertUploadable(file: OutgoingFile): void {
  if (file.bytes.length === 0) throw new FeishuUploadRejectedError('empty_file');
  const limit = file.kind === 'image' ? FEISHU_MAX_IMAGE_UPLOAD_BYTES : FEISHU_MAX_FILE_UPLOAD_BYTES;
  if (file.bytes.length > limit) throw new FeishuUploadRejectedError('file_too_large');
}

export type FeishuFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';

const DOC_TYPES = new Set(['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
const XLS_TYPES = new Set(['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const PPT_TYPES = new Set(['application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']);

export function feishuFileType(mediaType: string): FeishuFileType {
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType === 'video/mp4') return 'mp4';
  if (mediaType.startsWith('audio/')) return 'opus';
  if (DOC_TYPES.has(mediaType)) return 'doc';
  if (XLS_TYPES.has(mediaType)) return 'xls';
  if (PPT_TYPES.has(mediaType)) return 'ppt';
  return 'stream';
}

export function toWebStream(readable: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(readable) as ReadableStream<Uint8Array>;
}
