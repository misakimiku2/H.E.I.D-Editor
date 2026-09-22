/**
 * 二维码图片。qrcode 库只在「关于」面板打开时才用得到，故本文件由 React.lazy 动态引入，
 * 拆成独立 chunk 不进主包（主包体积是一等约束）。
 * 输出 SVG 的 data URL 交给 <img>，不经 innerHTML。
 */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export default function QrImage({ text, size = 140 }: { text: string; size?: number }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    /* margin 2 = 四周留 2 个模块的空白：库默认不出白底，靠外层 bg-white 的盒子垫出对比度 */
    QRCode.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' })
      .then(svg => { if (alive) setSrc(`data:image/svg+xml,${encodeURIComponent(svg)}`); })
      .catch(() => { if (alive) setSrc(''); });
    return () => { alive = false; };
  }, [text]);
  if (!src) return <div style={{ width: size, height: size }} aria-hidden />;
  return <img src={src} width={size} height={size} alt="" style={{ imageRendering: 'pixelated' }} />;
}
