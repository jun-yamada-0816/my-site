/* index.html 用の Tailwind 設定。
   以前 index.html の中にあった tailwind.config（ブラウザで組み立てる Play CDN 用）と同じ内容です。
   index.html で Tailwind のクラスを増やしたり変えたりしたら、このフォルダで
     npm install   （初回だけ）
     npm run build
   を実行して ../../tailwind.css を作り直してください。作り直さないと、新しいクラスは効きません。 */
module.exports = {
  content: {
    relative: true,
    files: ['../../index.html'],
  },
  // JS の中で組み立てているクラス名（notConfiguredMsg の text-${color}/70）は、ファイルを読んでも見つからないので明記する
  safelist: ['text-aurora-blue/70', 'text-aurora-teal/70', 'text-aurora-indigo/70'],
  theme: {
    extend: {
      colors: {
        /* 星空の背景でも読める、水色・藤色・浅葱のアクセント。 */
        aurora: {
          blue:   '#9ed9f4',
          indigo: '#a6bde2',
          violet: '#c2b3e6',
          teal:   '#a0d4ce',
        },
        sumi:   '#2b2f33',
        kinari: '#f6f3ec',
        shu:    '#b7472a',
      },
      animation: {
        'float':      'float 6s ease-in-out infinite',
        'shimmer':    'shimmer 8s linear infinite',
        'fade-in-up': 'fadeInUp 1s ease-out forwards',
        'fade-in':    'fadeIn 1.5s ease-out forwards',
        'spin-slow':  'spin 1.2s linear infinite',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%':      { transform: 'translateY(-18px)' },
        },
        shimmer: {
          '0%':   { backgroundPosition: '-200% center' },
          '100%': { backgroundPosition:  '200% center' },
        },
        fadeInUp: {
          '0%':   { opacity: '0', transform: 'translateY(40px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        fadeIn: {
          '0%':   { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
};
