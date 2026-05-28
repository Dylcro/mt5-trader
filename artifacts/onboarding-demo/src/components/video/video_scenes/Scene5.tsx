import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene5() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 500), // Modal fully gone, chart pop
      setTimeout(() => setPhase(2), 1200), // Controls slide up
      setTimeout(() => setPhase(3), 2000), // Buy/Sell flash
      setTimeout(() => setPhase(4), 3500), // Exit
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute top-[5vh] bottom-[5vh] left-[30vw] right-[30vw] overflow-hidden bg-[#0A0A0A]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, filter: 'blur(20px)' }}
      transition={{ duration: 0.8 }}
    >
      <div className="flex flex-col h-full p-[2vw]">
        {/* Header */}
        <div className="flex justify-between items-end mb-[2vh]">
          <div>
            <motion.h1 
              className="text-[#C9A84C] font-display text-[2.5vw] leading-none"
              initial={{ y: -20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.6 }}
            >
              XAUUSD
            </motion.h1>
            <motion.div className="text-[#A0A0A0] text-[0.8vw] mt-[0.5vh]" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              GOLD / US DOLLAR
            </motion.div>
          </div>
          <motion.div 
            className="text-right"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
          >
            <div className="text-white text-[2vw] font-mono leading-none">2,345.67</div>
            <div className="text-[#34D399] text-[1vw]">+12.40 (+0.53%)</div>
          </motion.div>
        </div>
        
        {/* Chart Area */}
        <motion.div 
          className="flex-1 border border-[#282828] bg-[#141414] rounded-[1vw] relative overflow-hidden mb-[2vh]"
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: phase >= 1 ? 1 : 0.95, opacity: phase >= 1 ? 1 : 0 }}
          transition={{ type: 'spring', stiffness: 200, damping: 25 }}
        >
          {/* Abstract chart graphics */}
          <svg viewBox="0 0 100 50" className="w-full h-full stroke-[#C9A84C] stroke-[0.5] fill-none drop-shadow-[0_0_10px_rgba(201,168,76,0.5)]" preserveAspectRatio="none">
            <motion.path 
              d="M0,40 Q10,35 20,38 T40,25 T60,30 T80,10 T100,15" 
              initial={{ pathLength: 0 }}
              animate={{ pathLength: phase >= 1 ? 1 : 0 }}
              transition={{ duration: 1.5, ease: 'easeOut' }}
            />
          </svg>
          <motion.div 
            className="absolute top-[15%] right-[0%] w-[10vw] h-[1px] border-t border-dashed border-[#C9A84C]/50"
            initial={{ width: 0 }}
            animate={{ width: phase >= 1 ? '100%' : 0 }}
            transition={{ delay: 0.5, duration: 1 }}
          />
        </motion.div>

        {/* Trade Controls */}
        <motion.div 
          className="h-[12vh] bg-[#141414] border border-[#282828] rounded-[1vw] flex gap-[1vw] p-[1vw]"
          initial={{ y: 50, opacity: 0 }}
          animate={{ y: phase >= 2 ? 0 : 50, opacity: phase >= 2 ? 1 : 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
        >
          <div className="flex-1 flex flex-col items-center justify-center bg-[#EF4444]/10 border border-[#EF4444]/30 rounded-lg relative overflow-hidden">
            <div className="text-[#EF4444] text-[1vw] font-bold">SELL</div>
            <div className="text-white text-[1.2vw] font-mono">2345.50</div>
            {phase >= 3 && (
              <motion.div 
                className="absolute inset-0 bg-[#EF4444]"
                initial={{ opacity: 0.3 }}
                animate={{ opacity: 0 }}
                transition={{ duration: 0.5 }}
              />
            )}
          </div>

          <div className="flex-1 flex flex-col items-center justify-center bg-[#34D399]/10 border border-[#34D399]/30 rounded-lg relative overflow-hidden">
            <div className="text-[#34D399] text-[1vw] font-bold">BUY</div>
            <div className="text-white text-[1.2vw] font-mono">2345.85</div>
          </div>
        </motion.div>
      </div>

      {/* Tabs */}
      <div className="absolute bottom-0 left-0 right-0 h-[8vh] border-t border-[#282828] bg-[#0A0A0A]/80 backdrop-blur-md flex justify-around items-center px-[2vw] z-10">
        <div className="text-[#C9A84C] text-[1vw] font-bold">Trade</div>
        <div className="text-[#A0A0A0] text-[1vw]">Positions</div>
        <div className="text-[#A0A0A0] text-[1vw]">Settings</div>
      </div>
    </motion.div>
  );
}
