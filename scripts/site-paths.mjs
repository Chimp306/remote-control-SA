export function mapRequestPath(pathname) {
  if (pathname === '/PC') return { redirect: '/PC/' };
  if (pathname === '/SOLO') return { redirect: '/SOLO/' };
  if (pathname === '/FREQ') return { redirect: '/FREQ/' };
  if (pathname === '/') return { file: '/index.html' };
  if (pathname === '/PC/') return { file: '/PC/index.html' };
  if (pathname === '/SOLO/') return { file: '/SOLO/index.html' };
  if (pathname === '/FREQ/') return { file: '/FREQ/index.html' };
  return { file: pathname };
}
