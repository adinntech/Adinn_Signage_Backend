// utils/uploadToSpaces.js
const path = require('path');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const spacesClient = require('../config/spaces');

const uploadToSpaces = async (file, folder = 'Roadshows') => {
  // Generate unique filename
  const ext = path.extname(file.originalname);
  const fileName = `${folder}/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;

  // Determine if file is video based on mimetype
  const isVideo = file.mimetype.startsWith('video/');
  
  const command = new PutObjectCommand({
    Bucket: process.env.DO_SPACES_BUCKET,
    Key: fileName,
    Body: file.buffer,
    ACL: 'public-read',
    ContentType: file.mimetype,
    CacheControl: 'max-age=31536000', // 1 year cache
  });

  await spacesClient.send(command);

  // Return the full CDN URL
  return `${process.env.DO_SPACES_CDN_BASE}/${fileName}`;
};

module.exports = uploadToSpaces;