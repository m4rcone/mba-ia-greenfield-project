import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';

export class PresignPartsDto {
  @ApiProperty({
    type: [Number],
    example: [1, 2, 3],
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
    description: 'Part numbers ≥ 1 and ≤ the upload partCount',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}
