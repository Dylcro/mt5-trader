import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene4() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 400), // Modal pops up
      setTimeout(() => setPhase(2), 1000), // SL/TP highlights
      setTimeout(() => setPhase(3), 1600), // Cascade entries highlight
      setTimeout(() => setPhase(4), 2200), // Final config pulse
      setTimeout(() => setPhase(5), 3500), // Exit
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute top-[5vh] bottom-[5vh] left-[30vw] right-[30vw] overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {/* Background stays dim */}
      <div className="absolute inset-0 bg-[#0A0A0A] flex flex-col p-[2vw]">
        {/* Fake content under blur */}
      </div>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Settings Modal */}
      <motion.div 
        className="absolute bottom-[2vw] left-[2vw] right-[2vw] bg-[#141414] border border-[#C9A84C]/30 rounded-xl p-[2vw] shadow-2xl"
        initial={{ y: '50vh', opacity: 0 }}
        animate={phase >= 5 ? { y: '50vh', opacity: 0 } : phase >= 1 ? { y: 0, opacity: 1 } : { y: '50vh', opacity: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      >
        <div className="flex justify-between items-center mb-[2vh]">
          <h3 className="text-white font-display text-[1.5vw]">Configure Settings</h3>
          <div className="w-[4vw] h-[1.5vw] rounded-full bg-[#34D399]/20 flex items-center justify-center">
            <span className="text-[#34D399] text-[0.7vw] font-bold tracking-wider">CONNECTED</span>
          </div>
        </div>

        <div className="space-y-[1.5vh]">
          <motion.div 
            className="p-[1vw] rounded-lg border border-[#282828] bg-[#0A0A0A]"
            animate={{ borderColor: phase >= 2 ? 'rgba(201,168,76,0.5)' : 'rgba(40,40,40,1)' }}
          >
            <div className="text-white text-[0.9vw] font-semibold mb-[0.5vh]">Stop Loss & Take Profit</div>
            <div className="text-[#A0A0A0] text-[0.8vw]">Default SL pips and 4 TP levels for precision exits.</div>
          </motion.div>

          <motion.div 
            className="p-[1vw] rounded-lg border border-[#282828] bg-[#0A0A0A]"
            animate={{ borderColor: phase >= 3 ? 'rgba(201,168,76,0.5)' : 'rgba(40,40,40,1)' }}
          >
            <div className="text-white text-[0.9vw] font-semibold mb-[0.5vh]">Cascade Entries</div>
            <div className="text-[#A0A0A0] text-[0.8vw]">Multi-level entry configuration for scaling into zones.</div>
          </motion.div>
        </div>

        <motion.div 
          className="w-full h-[5vh] mt-[3vh] bg-[#C9A84C] rounded-md flex items-center justify-center"
          animate={{ scale: phase >= 4 ? [1, 1.02, 1] : 1 }}
          transition={{ duration: 0.5, repeat: phase >= 4 ? Infinity : 0, repeatDelay: 1.5 }}
        >
          <span className="text-[#0A0A0A] font-bold text-[1vw]">START TRADING</span>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
