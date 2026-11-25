export const VALID_EXTENSIONS = ['.v', '.sv', '.vh', '.svh'];

export const INVALID_NAME_MESSAGE = `File name must end with one of: ${VALID_EXTENSIONS.join(', ')}, and must not contain "/" (folders are not supported)`;

export function isValidFileName(name: string) {
  return VALID_EXTENSIONS.some((ext) => name.endsWith(ext)) && !name.includes('/');
}
