export function mapRequestPath(pathname) {
  if (pathname === '/SOLO' || pathname === '/SOLO/') return { redirect: '/solo/' };
  if (pathname === '/solo') return { redirect: '/solo/' };
  if (pathname === '/suc') return { redirect: '/suc/' };
  if (pathname === '/') return { file: '/index.html' };
  if (pathname === '/solo/') return { file: '/solo/index.html' };
  if (pathname === '/suc/') return { file: '/suc/index.html' };
  return { file: pathname };
}
