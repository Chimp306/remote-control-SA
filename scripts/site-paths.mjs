export function mapRequestPath(pathname) {
  if (pathname === '/PC') return { redirect: '/PC/' };
  if (pathname === '/' ) return { file: '/index.html' };
  if (pathname === '/PC/') return { file: '/PC/index.html' };
  return { file: pathname };
}
