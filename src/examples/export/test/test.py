import cocotb
from cocotb.clock import Clock
from cocotb.triggers import ClockCycles

import os
import glob
import itertools
from PIL import Image, ImageChops


@cocotb.test()
async def test_project(dut):

    # Set clock period to 40 ns (25 MHz)
    CLOCK_PERIOD = 40

    # Set VGA timing parameters matching hvsync_generator.v
    H_DISPLAY = 640
    H_FRONT   =  16
    H_SYNC    =  96
    H_BACK    =  48
    V_DISPLAY = 480
    V_FRONT   =  10
    V_SYNC    =   2
    V_BACK    =  33

    # Number of frames to capture
    CAPTURE_FRAMES = 3

    # Derived constants
    H_SYNC_START = H_DISPLAY + H_FRONT
    H_SYNC_END = H_SYNC_START + H_SYNC
    H_TOTAL = H_SYNC_END + H_BACK
    V_SYNC_START = V_DISPLAY + V_FRONT
    V_SYNC_END = V_SYNC_START + V_SYNC
    V_TOTAL = V_SYNC_END + V_BACK

    # Palette mapping uo_out values to RGB color
    palette = [0] * 256
    for r1, r0, g1, g0, b1, b0 in itertools.product(range(2), repeat=6):
        red = 170*r1 + 85*r0
        green = 170*g1 + 85*g0
        blue = 170*b1 + 85*b0
        palette[b0<<6|g0<<5|r0<<4|b1<<2|g1<<1|r1<<0] = bytes((red, green, blue))

    # Set up the clock
    clock = Clock(dut.clk, CLOCK_PERIOD, unit="ns")
    cocotb.start_soon(clock.start())

    # Reset the design
    dut.ena.value = 1
    dut.ui_in.value = 0
    dut.uio_in.value = 0
    dut.rst_n.value = 0
    await ClockCycles(dut.clk, 10)
    dut.rst_n.value = 1
    await ClockCycles(dut.clk, 2)

    # Define some functions for capturing lines & frames

    async def check_line(expected_vsync):
        for i in range(H_TOTAL):
            hsync = int(dut.uo_out.value[7])
            vsync = int(dut.uo_out.value[3])
            assert hsync == (1 if H_SYNC_START <= i < H_SYNC_END else 0), "Unexpected hsync pattern"
            assert vsync == expected_vsync, "Unexpected vsync pattern"
            await ClockCycles(dut.clk, 1)

    async def capture_line(framebuffer, offset):
        for i in range(H_TOTAL):
            hsync = int(dut.uo_out.value[7])
            vsync = int(dut.uo_out.value[3])
            assert hsync == (1 if H_SYNC_START <= i < H_SYNC_END else 0), "Unexpected hsync pattern"
            assert vsync == 0, "Unexpected vsync pattern"
            if i < H_DISPLAY:
                framebuffer[offset+3*i:offset+3*i+3] = palette[int(dut.uo_out.value)]
            await ClockCycles(dut.clk, 1)

    async def skip_frame(frame_num):
        dut._log.info(f"Skipping frame {frame_num}")
        await ClockCycles(dut.clk, H_TOTAL*V_TOTAL)

    async def capture_frame(frame_num, check_sync=True):
        framebuffer = bytearray(V_DISPLAY*H_DISPLAY*3)
        for j in range(V_DISPLAY):
            dut._log.info(f"Frame {frame_num}, line {j} (display)")
            line = await capture_line(framebuffer, 3*j*H_DISPLAY)
        if check_sync:
            for j in range(j, j+V_FRONT):
                dut._log.info(f"Frame {frame_num}, line {j} (front porch)")
                await check_line(0)
            for j in range(j, j+V_SYNC):
                dut._log.info(f"Frame {frame_num}, line {j} (sync pulse)")
                await check_line(1)
            for j in range(j, j+V_BACK):
                dut._log.info(f"Frame {frame_num}, line {j} (back porch)")
                await check_line(0)
        else:
            dut._log.info(f"Frame {frame_num}, skipping non-display lines")
            await ClockCycles(dut.clk, H_TOTAL*(V_TOTAL-V_DISPLAY))
        frame = Image.frombytes('RGB', (H_DISPLAY, V_DISPLAY), bytes(framebuffer))
        return frame

    # Start capturing

    os.makedirs("output", exist_ok=True)

    for i in range(CAPTURE_FRAMES):
        frame = await capture_frame(i)
        frame.save(f"output/frame{i}.png")


@cocotb.test()
async def compare_reference(dut):

    for img in glob.glob("output/frame*.png"):
        basename = img.removeprefix("output/")
        dut._log.info(f"Comparing {basename} to reference image")
        frame = Image.open(img)
        ref = Image.open(f"reference/{basename}")
        diff = ImageChops.difference(frame, ref)
        if diff.getbbox() is not None:
            diff.save(f"output/diff_{basename}")
            assert False, f"Rendered {basename} differs from reference image"
