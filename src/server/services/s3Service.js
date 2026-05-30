const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const fs = require('fs');

class S3Service {
  constructor() {
    this.enabled = process.env.S3_BRIDGE_ENABLED === 'true';
    this.bucket = process.env.S3_BUCKET || 'torrentedge-artifacts';
    
    if (this.enabled) {
      this.s3Client = new S3Client({
        region: process.env.AWS_REGION || 'us-east-1',
        endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true', // Required for MinIO
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'admin',
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'password'
        }
      });
      console.log('[S3Service] Cold Start Bridge initialized targeting', process.env.S3_ENDPOINT || 'http://localhost:9000');
    } else {
      console.log('[S3Service] S3 Bridge disabled. Running in pure P2P mode.');
    }
  }

  /**
   * Uploads a file stream directly to S3/MinIO using the Upload class for efficient chunking.
   * Maintains strict zero-buffer RAM policy.
   * @param {string} localFilePath Path to the file to upload
   * @param {string} objectKey The infoHash of the torrent
   * @returns {Promise<string>} The uploaded object key
   */
  async uploadArtifact(localFilePath, objectKey) {
    if (!this.enabled) return null;

    try {
      console.log(`[S3Service] Starting dual-write backup for ${objectKey}`);
      const fileStream = fs.createReadStream(localFilePath);

      const parallelUploads3 = new Upload({
        client: this.s3Client,
        params: {
          Bucket: this.bucket,
          Key: objectKey,
          Body: fileStream,
        },
        queueSize: 4, // 4 concurrent uploads
        partSize: 1024 * 1024 * 5, // 5 MB chunks
        leavePartsOnError: false,
      });

      parallelUploads3.on('httpUploadProgress', (progress) => {
        // Optional: emit to observability layer if needed
      });

      await parallelUploads3.done();
      console.log(`[S3Service] Successfully backed up ${objectKey} to S3`);
      return objectKey;
    } catch (err) {
      console.error(`[S3Service] Failed to upload ${objectKey}:`, err.message);
      throw err;
    }
  }

  /**
   * Generates a short-lived Pre-Signed URL for a worker to download an artifact.
   * Used exclusively during Cold Start Resurrection.
   * @param {string} objectKey The infoHash of the torrent
   * @param {number} expiresIn Seconds until URL expires
   * @returns {Promise<string>} Pre-Signed HTTP URL
   */
  async generatePresignedUrl(objectKey, expiresIn = 900) {
    if (!this.enabled) throw new Error('S3 Bridge is disabled');

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
    });

    try {
      const url = await getSignedUrl(this.s3Client, command, { expiresIn });
      // When testing locally via Docker, the backend connects to MinIO via 'http://minio:9000'.
      // But the pre-signed URL might be used by a process on the host (e.g. tedge CLI or a local worker).
      // We rewrite the hostname to localhost if needed, though usually the worker handles this logic.
      let finalUrl = url;
      if (process.env.NODE_ENV !== 'production' && url.includes('http://minio:9000')) {
        finalUrl = url.replace('http://minio:9000', 'http://localhost:9000');
      }
      return finalUrl;
    } catch (err) {
      console.error(`[S3Service] Failed to generate Pre-Signed URL for ${objectKey}:`, err);
      throw err;
    }
  }
}

module.exports = new S3Service();
