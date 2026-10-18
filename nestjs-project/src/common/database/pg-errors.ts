import { QueryFailedError } from 'typeorm';

const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolationOnColumn(
  err: unknown,
  column: string,
): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err.driverError as {
    code?: string;
    detail?: string;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(`(${column})`)
  );
}
