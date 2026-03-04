import hvsync_generator_v from '../common/hvsync_generator.v?raw';
import bitmap_rom_v from './bitmap_rom.v?raw';
import palette_v from './palette.v?raw';
import project_v from './project.v?raw';

export const logo = {
  id: 'logo',
  name: 'Logo',
  author: 'Uri Shaked',
  sources: {
    'project.v': project_v,
    'hvsync_generator.v': hvsync_generator_v,
    'palette.v': palette_v,
    'bitmap_rom.v': bitmap_rom_v,
  },
};
