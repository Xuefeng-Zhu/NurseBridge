import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';
import type { NextConfig } from 'next';
initOpenNextCloudflareForDev();
const config:NextConfig={transpilePackages:['@nursebridge/contracts','@nursebridge/audio-client','@nursebridge/intake-policy','@nursebridge/database'],poweredByHeader:false,async headers(){return [{source:'/:path*',headers:[{key:'X-Content-Type-Options',value:'nosniff'},{key:'Referrer-Policy',value:'no-referrer'},{key:'Permissions-Policy',value:'microphone=(self), camera=(), geolocation=()'},{key:'Content-Security-Policy',value:"frame-ancestors 'none'; object-src 'none'; base-uri 'self'"}]}]}};
export default config;
