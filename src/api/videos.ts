import { join } from "path";
import { randomUUID, randomBytes } from "crypto";
import { respondWithJSON } from "./json";
import { getBearerToken, validateJWT } from "../auth";
import { UserForbiddenError, BadRequestError } from "./errors.ts";
import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { getVideo, updateVideo } from "../db/videos.ts";
import { s3, S3Client } from "bun";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 10 * 1024 * 1024 * 1024;
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);

  if (!video) {
    throw new BadRequestError("Video not found");
  }
  if (video.userID != userID) {
    throw new UserForbiddenError("Not Authorized");
  }

  const formData = await req.formData();
  const upload = formData.get("video");
  if (!(upload instanceof File)) {
    throw new BadRequestError("Not an image");
  }

  if (upload.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Too Large");
  }
  if (upload.type != "video/mp4") {
    throw new BadRequestError("Invalid format");
  }
  let fileName = randomUUID() + ".mp4";
  const fsPath = join(cfg.assetsRoot, `${fileName}.mp4`);

  await Bun.write(fsPath, upload, { createPath: true });
  const key = randomUUID() + ".mp4";
  const bucketPath = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
  const file = Bun.file(fsPath);

  const bucketFile = S3Client.file(key, {
    ...cfg.s3Client,
    type: file.type,
  });
  await bucketFile.write(file, { type: file.type });
  video.videoURL = bucketPath;

  updateVideo(cfg.db, video);
  await file.delete();

  return respondWithJSON(200, null);
}
