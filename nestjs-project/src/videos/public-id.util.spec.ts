import { generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  const SAMPLE_SIZE = 100_000;
  const samples = Array.from({ length: SAMPLE_SIZE }, () => generatePublicId());

  it('should always produce 11 base62 characters', () => {
    const invalid = samples.filter((id) => !/^[0-9A-Za-z]{11}$/.test(id));

    expect(invalid).toEqual([]);
  });

  it('should not collide across a large sample', () => {
    expect(new Set(samples).size).toBe(SAMPLE_SIZE);
  });

  it('should use the whole base62 alphabet', () => {
    const seen = new Set(samples.join(''));

    expect(seen.size).toBe(62);
  });
});
