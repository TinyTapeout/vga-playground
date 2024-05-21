import hvsync_generator_v from '../common/hvsync_generator.v?raw';
import project_v from './project.v?raw';

export const logo = {
  name: 'Logo',
  author: 'Uri Shaked',
  topModule: 'tt_um_vga_example',
  sources: {
    'project.v': project_v,
    'hvsync_generator.v': hvsync_generator_v,
  },
};
