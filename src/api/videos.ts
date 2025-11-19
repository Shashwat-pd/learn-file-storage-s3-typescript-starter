import { join } from "path";
import { randomUUID, randomBytes } from "crypto";
import { respondWithJSON } from "./json";
import { getBearerToken, validateJWT } from "../auth";
import { UserForbiddenError, BadRequestError } from "./errors.ts";
import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { getVideo, updateVideo, type Video } from "../db/videos.ts";
import { s3, S3Client } from "bun";
import { argv0, stdout } from "process";

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
  const fsPath = join(cfg.assetsRoot, `${fileName}`);

  await Bun.write(fsPath, upload, { createPath: true });
  const newPath = await processVideoForFastStart(fsPath);

  const ratio = await getVideoAspectRatio(fsPath);
  const key = ratio + "/" + randomUUID() + ".mp4";
  //const bucketPath = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
  const bucketPath = `${key}`;
  const file = Bun.file(newPath);

  const bucketFile = S3Client.file(key, {
    ...cfg.s3Client,
    type: file.type,
  });
  await bucketFile.write(file, { type: file.type });
  video.videoURL = bucketPath;

  updateVideo(cfg.db, video);
  await file.delete();
  await Bun.file(fsPath).delete();

  return respondWithJSON(200, dbVideoToSignedVideo(cfg, video));
}
async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn({
    cmd: [
      "ffprobe",
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      filePath,
    ],
  });

  await proc.exited;
  if (proc.exitCode == 0) {
    const output = proc.stdout.getReader();
    const outputReader = await output.read();
    const decoder = new TextDecoder();
    const content = outputReader.value;
    const str = decoder.decode(content);

    const json = JSON.parse(str);

    const width = json.streams[0].width;
    const height = json.streams[0].height;
    if (height > width) {
      return "portrait";
    } else if (width > height) {
      return "landscape";
    }
    return "other";
  } else {
    throw "Error Reading Video Data";
  }
}

async function processVideoForFastStart(inputFilePath: string) {
  let newpath = inputFilePath + ".processed";
  const proc = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      newpath,
    ],
  });

  await proc.exited;
  if (proc.exitCode == 0) {
    return newpath;
  } else {
    throw "Error Reading Video Data";
  }
}

function generatePresignedURL(cfg: ApiConfig, key: string, expireTime: number) {
  return S3Client.presign(key, { ...cfg.s3Client, expiresIn: expireTime });
}

export function dbVideoToSignedVideo(cfg: ApiConfig, video: Video) {
  if (!video.videoURL) {
    return video;
  }
  const signedVideo = {
    ...video,
    videoURL: generatePresignedURL(cfg, video.videoURL, 3600),
  };
  return signedVideo;
}
