import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import { config } from '../lib/config.js';

const s3 = new S3Client({
  region: 'auto',
  endpoint: config.R2_ENDPOINT,
  credentials: {
    accessKeyId: config.R2_ACCESS_KEY_ID,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = config.R2_BUCKET_NAME;

export const storageService = {
  async uploadPdf(fileHash: string, buffer: Buffer): Promise<string> {
    const r2Key = `pdfs/${fileHash}.pdf`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: r2Key,
      Body: buffer,
      ContentType: 'application/pdf',
    }));
    return r2Key;
  },

  /**
   * Upload a source book file (PDF or EPUB). PDFs land in pdfs/ for backwards
   * compat with existing storage; EPUBs land in epubs/. Extension in the key
   * reflects the format so downloaders can pick the right parser.
   */
  async uploadBookFile(fileHash: string, buffer: Buffer, format: 'pdf' | 'epub'): Promise<string> {
    if (format === 'pdf') return this.uploadPdf(fileHash, buffer);
    const r2Key = `epubs/${fileHash}.epub`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: r2Key,
      Body: buffer,
      ContentType: 'application/epub+zip',
    }));
    return r2Key;
  },

  async uploadNib(fileHash: string, nibJson: string): Promise<string> {
    const r2Key = `nibs/${fileHash}.nib.json`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: r2Key,
      Body: nibJson,
      ContentType: 'application/json',
    }));
    return r2Key;
  },

  async downloadPdf(r2Key: string): Promise<Buffer> {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: r2Key }));
    const stream = res.Body as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  },

  /**
   * Open a book file as a web ReadableStream instead of a Buffer, so a caller
   * can pipe R2 straight to the client without ever holding the whole file in
   * heap. transformToWebStream() is Readable.toWeb() under the hood, so
   * backpressure is preserved and memory stays at one chunk regardless of file
   * size. contentLength comes from R2 rather than pdf_files.size_bytes so the
   * Content-Length we advertise always matches the bytes we are about to send.
   *
   * downloadPdf() above stays for the callers that hand the whole file to
   * pdf.js or the EPUB parser and genuinely need it materialised.
   */
  async openBookFileStream(r2Key: string): Promise<{ stream: ReadableStream; contentLength?: number }> {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: r2Key }));
    if (!res.Body) throw new Error(`R2 object has no body: ${r2Key}`);
    return {
      stream: res.Body.transformToWebStream(),
      contentLength: res.ContentLength,
    };
  },

  async getNibUrl(r2Key: string): Promise<string> {
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: r2Key }), { expiresIn: 3600 });
  },

  async uploadAvatar(userId: string, buffer: Buffer, _contentType: string): Promise<string> {
    const resized = await sharp(buffer)
      .resize(256, 256, { fit: 'cover' })
      .webp({ quality: 80 })
      .toBuffer();

    const r2Key = `avatars/${userId}.webp`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: r2Key,
      Body: resized,
      ContentType: 'image/webp',
    }));
    return r2Key;
  },

  async getAvatarUrl(r2Key: string): Promise<string> {
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: r2Key }), { expiresIn: 604800 }); // 7 days
  },

  async deleteObject(r2Key: string): Promise<void> {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: r2Key }));
  },
};
