import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene2() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 400),
      setTimeout(() => setPhase(2), 800),
      setTimeout(() => setPhase(3), 1200),
      setTimeout(() => setPhase(4), 1600),
      setTimeout(() => setPhase(5), 2500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute top-[5vh] bottom-[5vh] left-[30vw] right-[30vw] flex flex-col items-center pt-[15vh] px-[4vw]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.h2 
        className="text-[2vw] font-display text-white mb-[1vh]"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: phase >= 1 ? 1 : 0, y: phase >= 1 ? 0 : 20 }}
      >
        Welcome Back
      </motion.h2>
      
      <motion.p
        className="text-[1vw] text-[#A0A0A0] mb-[6vh]"
        initial={{ opacity: 0 }}
        animate={{ opacity: phase >= 2 ? 1 : 0 }}
      >
        Sign in to your premium terminal
      </motion.p>

      <div className="w-full space-y-[2vh]">
        <motion.div 
          className="w-full h-[6vh] bg-[#141414] border border-[#282828] rounded-md px-[1vw] flex items-center"
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: phase >= 3 ? 1 : 0, x: phase >= 3 ? 0 : -20 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        >
          <div className="text-[#A0A0A0] text-[1vw]">user@example.com</div>
        </motion.div>

        <motion.div 
          className="w-full h-[6vh] bg-[#141414] border border-[#282828] rounded-md px-[1vw] flex items-center"
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: phase >= 4 ? 1 : 0, x: phase >= 4 ? 0 : -20 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        >
          <div className="text-[#A0A0A0] tracking-widest text-[1vw]">••••••••</div>
        </motion.div>

        <motion.div 
          className="w-full h-[6vh] bg-[#C9A84C] rounded-md flex items-center justify-center mt-[4vh] relative overflow-hidden"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: phase >= 5 ? 1 : 0, y: phase >= 5 ? 0 : 20 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        >
          <span className="text-[#0A0A0A] font-bold text-[1.1vw]">SIGN IN</span>
          <motion.div 
            className="absolute top-0 bottom-0 left-0 w-[5vw] bg-white opacity-30 blur-md skew-x-[30deg]"
            initial={{ x: '-10vw' }}
            animate={{ x: phase >= 5 ? '50vw' : '-10vw' }}
            transition={{ delay: 2.8, duration: 0.6, ease: 'easeInOut' }}
          />
        </motion.div>
      </div>
    </motion.div>
  );
}
