// storage/s3Adapter.js
// Production storage adapter: PDFs go to an S3-compatible bucket (AWS S3,
// Cloudflare R2, Backblaze B2, DigitalOcean Spaces, etc). The database
// only ever stores the object key — never the file bytes, never a public
// URL. Access is granted via short-lived presigned URLs, generated only
// after routes/library.js has verified the requesting user is authorized.
//
// Requires packages NOT installed by default in this project:
//   npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
//
// Required environment variables (see .env.example):
//   STORAGE_PROVIDER=s3
//   S3_BUCKET=your-bucket-name
//   S3_REGION=auto-or-your-region
//   S3_ACCESS_KEY_ID=...
//   S3_SECRET_ACCESS_KEY=...
//   S3_ENDPOINT=...            (optional — set for R2/B2/Spaces; omit for AWS S3)
//   S3_FORCE_PATH_STYLE=true   (optional — some non-AWS providers need this)
//
// IMPORTANT: this adapter could not be exercised against a real bucket in
// the environment this was written in (no network access, no cloud
// credentials available there). Test it yourself against a real bucket
// before relying on it — see README.md's local testing instructions.

let S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, getSignedUrl;
try {
  ({ S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3'));
  ({ getSignedUrl } = require('@aws-sdk/s3-request-presigner'));
} catch (e) {
  throw new Error(
    "STORAGE_PROVIDER=s3 but the AWS SDK packages aren't installed. Run:\n" +
    "  npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner"
  );
}

const REQUIRED = ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  throw new Error(`STORAGE_PROVIDER=s3 but missing required env vars: ${missing.join(', ')}`);
}

const client = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
  }
});
const BUCKET = process.env.S3_BUCKET;

module.exports = {
  provider: 's3',

  async putObject(key, buffer, contentType = 'application/pdf') {
    await client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      // Explicitly private — access only ever happens via presigned URLs.
      ACL: 'private'
    }));
  },

  async getObjectBuffer(key) {
    const result = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const chunks = [];
    for await (const chunk of result.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  },

  async deleteObject(key) {
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  },

  async getPresignedDownloadUrl(key, expiresSeconds = 300) {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    return getSignedUrl(client, command, { expiresIn: expiresSeconds });
  }
};
