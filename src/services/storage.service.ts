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
