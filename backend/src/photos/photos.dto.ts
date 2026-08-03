import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min
} from "class-validator";

export class StartUploadDto {
  @IsDateString()
  date!: string;

  @IsString()
  @Length(1, 200)
  originalName!: string;

  @IsIn(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"])
  contentType!: string;

  @IsInt()
  @Min(1)
  @Max(20 * 1024 * 1024)
  fileSize!: number;

  @IsUUID()
  clientUploadId!: string;

  @IsOptional()
  @IsDateString()
  capturedAt?: string;

  @IsOptional()
  @IsIn(["EXIF_ORIGINAL", "EXIF_CREATED", "FILE_MODIFIED", "USER", "DEFAULT"])
  dateSource?: "EXIF_ORIGINAL" | "EXIF_CREATED" | "FILE_MODIFIED" | "USER" | "DEFAULT";

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  childTagIds?: string[];
}

export class RepresentativeDto {
  @IsString()
  photoId!: string;
}
