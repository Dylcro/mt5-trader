import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene1() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 1000),
      setTimeout(() => setPhase(3), 2000),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center bg-[#0A0A0A]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.1, filter: 'blur(10px)' }}
      transition={{ duration: 0.8, ease: 'easeInOut' }}
    >
      <motion.div 
        className="w-[10vw] h-[10vw] border-[0.2vw] border-[#C9A84C] flex items-center justify-center rounded-sm rotate-45 mb-[4vh]"
        initial={{ scale: 0, rotate: 0 }}
        animate={{ scale: phase >= 1 ? 1 : 0, rotate: phase >= 1 ? 45 : 0 }}
        transition={{ type: 'spring', stiffness: 200, damping: 20 }}
      >
        <div className="w-[4vw] h-[4vw] bg-[#C9A84C] -rotate-45"></div>
      </motion.div>

      <motion.h1 
        className="text-[4vw] font-display text-white tracking-widest uppercase"
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: phase >= 2 ? 1 : 0, y: phase >= 2 ? 0 : 30 }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      >
        MT5 Trader
      </motion.h1>

      <motion.div
        className="h-[1px] bg-gradient-to-r from-transparent via-[#C9A84C] to-transparent mt-[2vh]"
        initial={{ width: 0, opacity: 0 }}
        animate={{ width: phase >= 3 ? '20vw' : 0, opacity: phase >= 3 ? 0.5 : 0 }}
        transition={{ duration: 1, ease: 'easeInOut' }}
      />
    </motion.div>
  );
}
