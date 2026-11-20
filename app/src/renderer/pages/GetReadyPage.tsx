import { Banner } from '@/components/banner';
import { Typography } from '@/components/typography';
import HerBanner from '@/assets/images/banner/hero-banner.svg';
import { HardDrive, ShieldCheck, Lock } from 'lucide-react';

/** Content area for the "Get ready" step. */
const features = [
  {
    icon: ShieldCheck,
    description: 'Works fully offline, no internet needed',
  },
  {
    icon: Lock,
    description: 'Your data stays on this computer',
  },
  {
    icon: HardDrive,
    description: 'Needs about 60 GB of space on drive C',
  },
];

export function GetReadyPage() {
  return (
    <div className="w-full flex flex-col gap-[32px]">
      <Banner src={HerBanner} alt="Hero banner" />
      <div className="flex flex-col gap-[10px]">
        <Typography variant="h1">
          Welcome to Enterprise Brain
        </Typography>
        <Typography variant="body" className="text-subtle-foreground">
          Your private AI workspace, running on this computer.
        </Typography>
      </div>
      <div className="flex flex-col gap-[16px]">
        {
          features.map((feature, index) => (
            <div key={index} className="flex flex-row gap-[12px] items-center">
              <div className="w-[28px] h-[28px] rounded-full bg-icon-badge flex items-center justify-center">
                <feature.icon aria-hidden size={14} className="text-icon-badge-foreground" />
              </div>
              <Typography variant="body">
                {feature.description}
              </Typography>
            </div>
          ))
        }
      
      </div>
    </div>
  );
}
