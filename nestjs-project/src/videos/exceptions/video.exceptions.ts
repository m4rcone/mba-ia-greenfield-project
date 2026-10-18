import { DomainException } from '../../common/exceptions/domain.exception';

export class UnsupportedVideoFormatException extends DomainException {
  constructor() {
    super(
      'UNSUPPORTED_VIDEO_FORMAT',
      400,
      'File extension and content type must be one of the supported video formats and agree with each other',
    );
  }
}

export class InvalidPartNumberException extends DomainException {
  constructor() {
    super(
      'INVALID_PART_NUMBER',
      400,
      'Part number exceeds the part count of the upload',
    );
  }
}

export class UploadSizeMismatchException extends DomainException {
  constructor() {
    super(
      'UPLOAD_SIZE_MISMATCH',
      400,
      'Uploaded file size does not match the declared size',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class UploadNotInProgressException extends DomainException {
  constructor() {
    super('UPLOAD_NOT_IN_PROGRESS', 409, 'Video upload is not in progress');
  }
}

export class UploadIncompleteException extends DomainException {
  constructor() {
    super(
      'UPLOAD_INCOMPLETE',
      409,
      'Uploaded parts do not cover the whole file',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready yet');
  }
}
