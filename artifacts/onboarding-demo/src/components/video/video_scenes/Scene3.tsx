import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene3() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200), // Background app reveals
      setTimeout(() => setPhase(2), 600), // Modal pops up
      setTimeout(() => setPhase(3), 1200), // Step 1 highlights
      setTimeout(() => setPhase(4), 1800), // Step 2 highlights
      setTimeout(() => setPhase(5), 2400), // Connect button pulse
      setTimeout(() => setPhase(6), 3500), // Exit transition starts
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute top-[5vh] bottom-[5vh] left-[30vw] right-[30vw] overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
    >
      {/* Fake App Background */}
      <div className="absolute inset-0 bg-[#0A0A0A] flex flex-col p-[2vw]">
        <div className="flex justify-between items-center mb-[4vh]">
          <div className="text-[#C9A84C] font-display text-[2vw]">XAUUSD</div>
          <div className="text-white text-[1.5vw]">2345.67</div>
        </div>
        
        {/* Fake Chart */}
        <div className="flex-1 border border-[#282828] bg-[#141414] rounded-lg relative overflow-hidden mb-[8vh]">
          <svg viewBox="0 0 100 50" className="w-full h-full stroke-[#C9A84C] stroke-[0.5] fill-none" preserveAspectRatio="none">
            <path d="M0,40 Q10,35 20,38 T40,25 T60,30 T80,10 T100,15" />
          </svg>
        </div>

        {/* Fake Tabs */}
        <div className="absolute bottom-0 left-0 right-0 h-[8vh] border-t border-[#282828] bg-[#0A0A0A] flex justify-around items-center px-[2vw]">
          <div className="w-[2vw] h-[2vw] rounded-full bg-[#C9A84C]"></div>
          <div className="w-[2vw] h-[2vw] rounded-full bg-[#282828]"></div>
          <div className="w-[2vw] h-[2vw] rounded-full bg-[#282828]"></div>
        </div>
      </div>

      {/* Dim Overlay */}
      <motion.div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: phase >= 2 ? 1 : 0 }}
      />

      {/* Onboarding Modal */}
      <motion.div 
        className="absolute bottom-[2vw] left-[2vw] right-[2vw] bg-[#141414] border border-[#C9A84C]/30 rounded-xl p-[2vw] shadow-2xl"
        initial={{ y: '50vh', opacity: 0 }}
        animate={phase >= 6 ? { y: '50vh', opacity: 0 } : phase >= 2 ? { y: 0, opacity: 1 } : { y: '50vh', opacity: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      >
        <h3 className="text-[#C9A84C] font-display text-[1.5vw] mb-[1vh]">Welcome to MT5 Trader</h3>
        <p className="text-[#A0A0A0] text-[1vw] mb-[2vh] leading-relaxed">
          Link your MetaTrader 5 account to begin trading gold.
        </p>

        <div className="space-y-[1.5vh]">
          <motion.div 
            className="flex items-center gap-[1vw] p-[1vw] rounded-lg bg-[#282828]/50"
            animate={{ backgroundColor: phase >= 3 ? 'rgba(201,168,76,0.1)' : 'rgba(40,40,40,0.5)' }}
          >
            <div className="w-[1.5vw] h-[1.5vw] rounded-full bg-[#C9A84C] text-[#0A0A0A] flex items-center justify-center text-[0.8vw] font-bold">1</div>
            <div className="text-white text-[0.9vw]">Open Settings</div>
          </motion.div>

          <motion.div 
            className="flex items-center gap-[1vw] p-[1vw] rounded-lg bg-[#282828]/50"
            animate={{ backgroundColor: phase >= 4 ? 'rgba(201,168,76,0.1)' : 'rgba(40,40,40,0.5)' }}
          >
            <div className="w-[1.5vw] h-[1.5vw] rounded-full bg-[#C9A84C] text-[#0A0A0A] flex items-center justify-center text-[0.8vw] font-bold">2</div>
            <div className="text-white text-[0.9vw]">Enter MT5 Details & Region</div>
          </motion.div>
        </div>

        <motion.div 
          className="w-full h-[5vh] mt-[2vh] bg-[#C9A84C] rounded-md flex items-center justify-center"
          animate={{ scale: phase >= 5 ? [1, 1.05, 1] : 1 }}
          transition={{ duration: 0.5, repeat: phase >= 5 ? Infinity : 0, repeatDelay: 1 }}
        >
          <span className="text-[#0A0A0A] font-bold text-[1vw]">CONNECT ACCOUNT</span>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
